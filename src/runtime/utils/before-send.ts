import type { Event, StackFrame } from '@sentry/core'

const EXTENSION_PROTOCOL = /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//u

/* Фрейм «не наш»: анонимный (<anonymous>/пусто) или из браузерного расширения. */
function isNoiseFrame(filename = ''): boolean {
  return filename === '' || filename === '<anonymous>' || EXTENSION_PROTOCOL.test(filename)
}

/*
 * Под catch-all (captureConsoleIntegration) message-based `ignoreErrors` НЕ ловит шум
 * с нормальным сообщением, но мусорным стеком: браузерное расширение рекурсивно патчит
 * глобал (напр. Object.getOwnPropertyDescriptor) → RangeError со стеком из одних анонимных
 * фреймов (issue KP-MODMB-COM-M). Дропаем event, если ВЕСЬ стек — не наши фреймы.
 * Event без exception/стека (обычный лог/сообщение) не трогаем.
 */
export function isNoiseEvent(event: Event): boolean {
  const frames = event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? []
  if (frames.length === 0) {
    return false
  }
  return frames.every((frame) => isNoiseFrame(frame.filename))
}

const CONSOLE_MECHANISM = 'auto.core.capture_console'

/* Событие captureConsoleIntegration: logger 'console' или console-mechanism у исключения. */
function isConsoleEvent(event: Event): boolean {
  return (
    event.logger === 'console' ||
    event.exception?.values?.some((value) => value.mechanism?.type === CONSOLE_MECHANISM) === true
  )
}

/*
 * Функции, которые никогда не бывают прикладным crash-location'ом:
 *   — sink логгера: console.* зовётся внутри output(), обёрнутого withSourceScope()
 *     из warn()/error()/info()/debug() (см. utils/logger.ts);
 *   — безымянные фреймы: arrow-callback внутри Sentry.withScope, обёртки рантайма.
 */
const NON_APP_FRAME_FUNCTIONS: Record<string, true> = {
  output: true,
  withSourceScope: true,
  warn: true,
  error: true,
  info: true,
  debug: true,
  '': true,
  '<anonymous>': true,
  '?': true,
}

/* Метод логгера — нижний кадр обвязки: следующий за ним кадр — вызывающий по построению,
 * каким бы ни было его имя. */
const LOGGER_METHODS: Record<string, true> = { warn: true, error: true, info: true, debug: true }

function demoteSinkFrames(frames: StackFrame[] | undefined): void {
  if (!frames) {
    return
  }
  /* Порядок frames — от старых к новым, ПОСЛЕДНИЙ фрейм верхний. Гасим in_app сверху вниз,
   * пока не встретим прикладной фрейм: он и станет crash-location. */
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i]
    if (!frame) {
      return
    }
    /* Уже погашенный in_app — фрейм рантайма (run из node:async_hooks сидит между
     * withSourceScope и warn): проходим сквозь него, прикладным его не считаем. */
    if (frame.in_app !== false && NON_APP_FRAME_FUNCTIONS[frame.function ?? ''] !== true) {
      return
    }
    frame.in_app = false
    /* Прошли warn()/error() логгера — ниже вызывающий. Он часто анонимный
     * (.catch((err) => logger.error(…))), и общий список имён погасил бы и его: событие
     * оставалось бы без единого прикладного кадра, а все такие места приложения слипались бы
     * в один issue по одинаковому стеку обвязки (ai.pushka.biz AI-PUSHKA-BIZ-5J). */
    if (LOGGER_METHODS[frame.function ?? ''] === true) {
      return
    }
  }
}

/*
 * Почему ВСЕ console-issue назывались «output».
 * captureConsoleIntegration для аргументов без Error зовёт captureMessage(msg, level,
 * { syntheticException }) → в event попадает exception.values[0] БЕЗ поля `type`: только
 * value + синтетический stacktrace и mechanism.type = auto.core.capture_console. Сервер
 * Sentry (eventtypes/error.py, get_title) при отсутствии metadata.type подставляет
 * metadata.function — имя функции crash-location, а crash-location = верхний in_app-фрейм.
 * Стек снят ВНУТРИ sink'а логгера, поэтому верхний фрейм всегда `output` (utils/logger.ts)
 * — и заголовок был одинаковым во всех проектах org'а.
 *
 * Правим три вещи: (1) exception.type = console.<level>; (2) снимаем mechanism.synthetic —
 * captureMessage с syntheticException ставит его, а сервер (eventtypes/error.py, get_metadata)
 * для synthetic-исключений НЕ кладёт type в metadata: заголовок оставался именем функции
 * crash-location, а value не участвовал в группировке. Без флага заголовок —
 * `console.warn: [tag] сообщение`; (3) гасим in_app у фреймов sink'а → culprit и
 * metadata.function указывают на реального вызывающего, а не на sink.
 *
 * Стек синтетического исключения обязан доставать до вызывающего: Bun и V8 режут его на 10
 * кадрах, а обвязка captureConsole + logger занимает 10 ровно (ai.pushka.biz, @sentry/core
 * внешним пакетом) — все logger.error приложения приходили с одинаковым стеком из одной
 * обвязки и слипались в один issue (AI-PUSHKA-BIZ-5J). Лимит поднимает instrument.server.ts /
 * plugin.client.ts (Error.stackTraceLimit) ДО Sentry.init.
 *
 * ВНИМАНИЕ: `type`, `synthetic` и `in_app` участвуют в группировке, поэтому деплой даёт
 * ОДНОРАЗОВУЮ перегруппировку: существующие console-issue перестанут получать события,
 * вместо них заведутся новые с читаемыми заголовками. Старые нужно просто закрыть.
 *
 * Typed exception (в args был настоящий Error → captureException) не трогаем вообще: у него
 * есть свой `type` и честный стек без фреймов sink'а.
 *
 * Мутирует event и возвращает его же; generic — чтобы в beforeSend сохранялся ErrorEvent.
 */
export function normalizeConsoleEvent<T extends Event>(event: T): T {
  if (!isConsoleEvent(event)) {
    return event
  }

  /* Имя console-метода ≠ Sentry-level: level 'warning' → console.warn, не console.warning. */
  const level = event.level ?? 'log'
  const type = level === 'warning' ? 'console.warn' : `console.${level}`

  for (const value of event.exception?.values ?? []) {
    if (value.type) {
      continue
    }
    value.type = type
    if (value.mechanism?.synthetic) {
      value.mechanism.synthetic = false
    }
    demoteSinkFrames(value.stacktrace?.frames)
  }

  return event
}

/*
 * Прямой Sentry.captureMessage под attachStacktrace: true идёт тем же путём, что console-события
 * (core eventFromMessage): текст — в event.message, стек вызова — в exception.values[0] БЕЗ type и
 * с mechanism.synthetic (mechanism.type = generic). Сервер для synthetic-исключения не кладёт type
 * в metadata, и заголовок issue — имя функции crash-location, а не сообщение: «announceFeedback»
 * вместо «Обратная связь от …» (ai.pushka.biz AI-PUSHKA-BIZ-5Q). У произвольного сообщения нет
 * типа, которым можно озаглавить exception (у console это console.<level>), поэтому стек переезжает
 * в threads — как делает attach_stacktrace в sentry-python: событие становится message-событием
 * (relay: нет exception → тип default, заголовок — первая строка сообщения), стек виден в issue,
 * группировка — по стеку единственного current-потока (grouping threads:v1; synthetic и раньше
 * исключал type/value) либо по fingerprint вызывающего.
 *
 * Только точная форма eventFromMessage: одно typeless synthetic-исключение при заполненном
 * message/logentry. Console-события (normalizeConsoleEvent) и настоящие исключения не трогаем.
 * Мутирует event и возвращает его же.
 */
export function normalizeMessageEvent<T extends Event>(event: T): T {
  const values = event.exception?.values
  if (values?.length !== 1 || isConsoleEvent(event) || (event.message === undefined && event.logentry === undefined)) {
    return event
  }
  const [value] = values
  if (value === undefined || value.type !== undefined || value.mechanism?.synthetic !== true) {
    return event
  }

  if (value.stacktrace?.frames?.length) {
    event.threads = { values: [{ stacktrace: value.stacktrace, crashed: false, current: true }] }
  }
  delete event.exception
  return event
}
