import type { Event } from '@sentry/core'

import { clip } from './clip'

/*
 * Отчёт в Sentry о watchdog'е «приложение не загрузилось за N с» (@mttzzz/nuxt-stale-deploy-guard ≥ 0.7.0;
 * стадии и диагностика — ≥ 0.8.0).
 *
 * Что это. Guard ставит таймер в свой inline-скрипт в <head> (раньше entry): если приложение не смонтировалось
 * за timeoutMs ВИДИМОГО ожидания (по умолчанию 45 с) — приложение не загрузилось. Пока это тишина: страница висит
 * (или висит пустой экран), а Sentry молчит — клиентский SDK не поднялся, ведь приложение не стартовало.
 *
 * Контракт события. Guard диспатчит window CustomEvent 'app:load-timeout' с detail:
 *   - reason: 'load-timeout';
 *   - timeoutMs — порог видимого ожидания; visibleMs — видимое время, набежавшее к отчёту (≥ timeoutMs);
 *     hiddenMs — max(0, elapsedMs - visibleMs): скрытая, замороженная или спящая вкладка; elapsedMs — сколько
 *     прошло по часам с момента исполнения inline-скрипта guard'а;
 *   - url — адрес страницы; kind — что не загрузилось ('chunk' | 'entry'), если watchdog видел сбой до отчёта;
 *   - stage — где застряла загрузка: 'network' (не пришли критичные ресурсы или сам документ ещё стримится) или
 *     'boot' (всё пришло, а приложение не стартовало); host — только у network: хост первого зависшего ресурса
 *     (если ждать нечего, а документ ещё стримится — host самой страницы);
 *   - readyState, online, vueMounted — состояние документа в момент отчёта (vueMounted: Vue смонтирован, а
 *     плагин guard'а о монтировании не сообщил);
 *   - pending (до 5 записей `host + pathname`), pendingCount, criticalCount — критичные ресурсы документа
 *     (stylesheet, modulepreload, script[src]) и сколько из них так и не появилось в Resource Timing;
 *   - errors (до 3) — первые runtime-ошибки до монтирования: `{ message, source? }`.
 * Guard 0.7.0 присылает только reason/timeoutMs/elapsedMs/url/kind (url — адрес страницы), а timeoutMs у него —
 * время по часам. Detail приходит из другой ревизии guard'а, поэтому каждое поле необязательно и проверяется по
 * типу отдельно: битое или отсутствующее поле просто не попадает в отчёт.
 *
 * Кто отправляет. ТОЛЬКО ранний beacon (early-beacon.ts): к моменту таймера клиентский SDK может быть не поднят
 * (приложение не стартовало — это и есть смысл watchdog'а), а при поднятом SDK второй отправитель дал бы дубль.
 * Поэтому SDK-путь (plugin.client.ts) это событие не слушает и не отправляет.
 *
 * Группировка. Отдельная issue на стадию, а у network — ещё и на хост первого зависшего ресурса: «не пришёл
 * CSS со шрифтами» и «не пришёл entry с CDN» — разные причины с разными владельцами. Без валидной стадии
 * (guard 0.7.0) — прежняя одна issue с заголовком без уточнения.
 *
 * Семейство отдельное от `app:chunk-reload-blocked`: свой fingerprint ('app-load-timeout'), свои теги ('load.*')
 * и свой контекст ('load'). Общая с остальными отчётами только форма события.
 *
 * Модуль не зависит от рантайма Sentry: событие строит чистая функция, а ранний inline-beacon вшивает те же
 * части заголовка в свой скрипт при сборке и дописывает в ES5-скрипте то, что известно только в браузере.
 */

export const LOAD_TIMEOUT_EVENT = 'app:load-timeout'

/*
 * Корень fingerprint. Стадия дописывается следом, у network — ещё и хост: ['app-load-timeout', 'network', host],
 * ['app-load-timeout', 'boot']. Без валидной стадии fingerprint — один корень (одна issue на watchdog).
 */
export const LOAD_TIMEOUT_FINGERPRINT = 'app-load-timeout'

export const LOAD_TIMEOUT_LEVEL = 'error'

/* Что не загрузилось, если watchdog видел сбой до таймаута. */
export const LOAD_TIMEOUT_KINDS = ['chunk', 'entry'] as const

export type LoadTimeoutKind = (typeof LOAD_TIMEOUT_KINDS)[number]

/* Где застряла загрузка: network — ждём ресурсы или сам документ; boot — ресурсы пришли, приложение не стартовало. */
export const LOAD_TIMEOUT_STAGES = ['network', 'boot'] as const

export type LoadTimeoutStage = (typeof LOAD_TIMEOUT_STAGES)[number]

/* Хост в заголовке и fingerprint network-события, когда guard его не прислал (или прислал не строку). */
export const LOAD_TIMEOUT_HOST_UNKNOWN = 'unknown'

export interface LoadTimeoutError {
  message: string
  /* `host + pathname:line:col` скрипта, где случилась ошибка; есть, если у ErrorEvent был filename. */
  source?: string
}

/*
 * Поля сверх reason/timeoutMs/elapsedMs присылает guard ≥ 0.8.0 (url и kind — и 0.7.0); у старого guard их нет,
 * поэтому на стороне отчёта все необязательны.
 */
export interface LoadTimeoutDetail {
  reason: 'load-timeout'
  timeoutMs: number
  elapsedMs: number
  visibleMs?: number
  hiddenMs?: number
  url?: string
  kind?: LoadTimeoutKind
  stage?: LoadTimeoutStage
  host?: string
  readyState?: string
  online?: boolean
  pending?: string[]
  pendingCount?: number
  criticalCount?: number
  vueMounted?: boolean
  errors?: LoadTimeoutError[]
}

/*
 * Части заголовка issue — отдельными константами, потому что их собирает и SDK-путь (здесь), и ES5-скрипт
 * раннего beacon'а: кириллица в тексте скрипта запрещена, а заголовок issue — русский.
 */
export const LOAD_TIMEOUT_MESSAGE_PREFIX = 'Приложение не загрузилось за '
export const LOAD_TIMEOUT_MESSAGE_SUFFIX = ' с'
export const LOAD_TIMEOUT_MESSAGE_GENERIC = 'Приложение не загрузилось'

/*
 * Уточнение по стадии — дописывается к заголовку выше: «…за 45 с: не пришли ресурсы (fonts.googleapis.com)»,
 * «…за 45 с: сбой при старте».
 */
export const LOAD_TIMEOUT_MESSAGE_NETWORK_PREFIX = ': не пришли ресурсы ('
export const LOAD_TIMEOUT_MESSAGE_NETWORK_SUFFIX = ')'
export const LOAD_TIMEOUT_MESSAGE_BOOT = ': сбой при старте'

/* Лимит значения тега Sentry — 200 символов; текст в контексте — 2000 (как maxValueLength у init). */
const TAG_VALUE_LIMIT = 200
const CONTEXT_TEXT_LIMIT = 2000

/* Поля detail, которые читает маппинг: guard приходит из другой ревизии, поэтому каждое проверяется по типу. */
interface DetailFields {
  timeoutMs?: unknown
  visibleMs?: unknown
  hiddenMs?: unknown
  elapsedMs?: unknown
  url?: unknown
  kind?: unknown
  stage?: unknown
  host?: unknown
  readyState?: unknown
  online?: unknown
  pending?: unknown
  pendingCount?: unknown
  criticalCount?: unknown
  vueMounted?: unknown
  errors?: unknown
}

type LoadTags = Record<string, string>
type LoadContext = Record<string, unknown>

/*
 * Сколько секунд показывать в заголовке. Без корректного timeoutMs (не число, не конечное, не положительное)
 * заголовок без числа: «Приложение не загрузилось».
 */
export function loadTimeoutSeconds(timeoutMs: unknown): number | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined
  }
  return Math.round(timeoutMs / 1000)
}

/* Заголовок issue: «Приложение не загрузилось за 45 с». */
export function loadTimeoutMessage(timeoutMs: unknown): string {
  const seconds = loadTimeoutSeconds(timeoutMs)
  return seconds === undefined
    ? LOAD_TIMEOUT_MESSAGE_GENERIC
    : `${LOAD_TIMEOUT_MESSAGE_PREFIX}${seconds}${LOAD_TIMEOUT_MESSAGE_SUFFIX}`
}

/* Строка из detail; не строка — пустая (поле считается отсутствующим). */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/*
 * Значение для тега, заголовка и fingerprint: одна строка без краёв (перевод строки Sentry в теге не
 * принимает), не длиннее лимита тега. Пустое — поле не валидно: пустая или состоящая из пробелов строка
 * ничего не сообщает.
 */
function labelOf(text: string): string {
  return clip(text.replaceAll(/\s+/gu, ' '), TAG_VALUE_LIMIT).trim()
}

/* Число: в контекст как есть, в тег строкой. Не конечное число — поле пропускается. */
function addNumber(tags: LoadTags, load: LoadContext, key: string, value: unknown, tagged = true): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return
  }
  load[key] = value
  if (tagged) {
    tags[`load.${key}`] = String(value)
  }
}

/* Флаг: в контекст булевым, в тег — строкой 'true' / 'false'. Не boolean — поле пропускается. */
function addFlag(tags: LoadTags, load: LoadContext, key: string, value: unknown): void {
  if (typeof value !== 'boolean') {
    return
  }
  load[key] = value
  tags[`load.${key}`] = String(value)
}

/* Массив строк; не строки внутри отбрасываются поштучно, не массив — поля нет. */
function textsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const items: unknown[] = value
  return items.filter((item): item is string => typeof item === 'string').map((item) => clip(item, CONTEXT_TEXT_LIMIT))
}

/* Ошибки до монтирования: запись без строкового message отбрасывается, битый source — только он. */
function errorsOf(value: unknown): LoadTimeoutError[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const entries: unknown[] = value
  const errors: LoadTimeoutError[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || !('message' in entry) || typeof entry.message !== 'string') {
      continue
    }
    const error: LoadTimeoutError = { message: clip(entry.message, CONTEXT_TEXT_LIMIT) }
    if ('source' in entry && typeof entry.source === 'string' && entry.source !== '') {
      error.source = clip(entry.source, CONTEXT_TEXT_LIMIT)
    }
    errors.push(error)
  }
  return errors
}

/*
 * Sentry-событие по detail watchdog'а. Заголовок и fingerprint зависят от стадии (см. шапку файла); теги —
 * то, по чему удобно искать и группировать, контекст `load` — всё валидное, включая pending и errors.
 */
export function toLoadTimeoutEvent(detail: LoadTimeoutDetail): Event {
  const fields: DetailFields = detail
  const tags: LoadTags = {}
  const load: LoadContext = {}
  const stage = LOAD_TIMEOUT_STAGES.find((candidate) => candidate === fields.stage)
  /* Хост только у network: у boot и у detail без стадии поле из detail игнорируется. */
  const host = stage === 'network' ? textOf(fields.host) : ''
  const hostLabel = labelOf(host)
  const readyState = textOf(fields.readyState)
  const readyStateLabel = labelOf(readyState)
  const url = textOf(fields.url)
  const pending = textsOf(fields.pending)
  const errors = errorsOf(fields.errors)
  const shownHost = hostLabel === '' ? LOAD_TIMEOUT_HOST_UNKNOWN : hostLabel
  let message = loadTimeoutMessage(fields.timeoutMs)
  const fingerprint: string[] = [LOAD_TIMEOUT_FINGERPRINT]

  addNumber(tags, load, 'timeoutMs', fields.timeoutMs)
  addNumber(tags, load, 'visibleMs', fields.visibleMs)
  addNumber(tags, load, 'hiddenMs', fields.hiddenMs)
  addNumber(tags, load, 'elapsedMs', fields.elapsedMs)
  if (url !== '') {
    load.url = clip(url, CONTEXT_TEXT_LIMIT)
  }
  const kind = LOAD_TIMEOUT_KINDS.find((candidate) => candidate === fields.kind)
  if (kind !== undefined) {
    tags['load.kind'] = kind
    load.kind = kind
  }
  if (stage !== undefined) {
    tags['load.stage'] = stage
    load.stage = stage
    fingerprint.push(stage)
  }
  if (stage === 'network') {
    message += `${LOAD_TIMEOUT_MESSAGE_NETWORK_PREFIX}${shownHost}${LOAD_TIMEOUT_MESSAGE_NETWORK_SUFFIX}`
    fingerprint.push(shownHost)
  } else if (stage === 'boot') {
    message += LOAD_TIMEOUT_MESSAGE_BOOT
  }
  if (hostLabel !== '') {
    tags['load.host'] = hostLabel
    load.host = clip(host, CONTEXT_TEXT_LIMIT)
  }
  if (readyStateLabel !== '') {
    tags['load.readyState'] = readyStateLabel
    load.readyState = clip(readyState, CONTEXT_TEXT_LIMIT)
  }
  addFlag(tags, load, 'online', fields.online)
  addFlag(tags, load, 'vueMounted', fields.vueMounted)
  addNumber(tags, load, 'pendingCount', fields.pendingCount)
  addNumber(tags, load, 'criticalCount', fields.criticalCount, false)
  if (pending !== undefined) {
    load.pending = pending
  }
  if (errors !== undefined) {
    load.errors = errors
  }

  return {
    message,
    level: LOAD_TIMEOUT_LEVEL,
    fingerprint,
    tags,
    contexts: { load },
  }
}
