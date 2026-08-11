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
 * Правим две вещи: (1) exception.type = console.<level> → заголовок становится
 * `console.warn: [tag] сообщение`; (2) гасим in_app у фреймов sink'а → culprit и
 * metadata.function указывают на реального вызывающего, а не на sink.
 *
 * ВНИМАНИЕ: `type` и `in_app` участвуют в группировке, поэтому деплой даёт ОДНОРАЗОВУЮ
 * перегруппировку: существующие console-issue перестанут получать события, вместо них
 * заведутся новые с читаемыми заголовками. Старые нужно просто закрыть.
 *
 * Typed exception (в args был настоящий Error → captureException) не трогаем вообще: у него
 * есть свой `type` и честный стек без фреймов sink'а.
 *
 * Мутирует event и возвращает его же; generic — чтобы в beforeSend сохранялся ErrorEvent.
 */
export function normalizeConsoleEvent<T extends Event>(event: T): T {
  const isConsole =
    event.logger === 'console' ||
    event.exception?.values?.some((value) => value.mechanism?.type === CONSOLE_MECHANISM) === true
  if (!isConsole) {
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
    demoteSinkFrames(value.stacktrace?.frames)
  }

  return event
}
