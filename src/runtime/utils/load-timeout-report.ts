import type { Event } from '@sentry/core'

import { clip } from './clip'

/*
 * Отчёт в Sentry о watchdog'е «приложение не загрузилось за N с» (@mttzzz/nuxt-stale-deploy-guard ≥ 0.7.0).
 *
 * Что это. Guard ставит таймер в свой inline-скрипт в <head> (раньше entry): если приложение не смонтировалось
 * за timeoutMs (по умолчанию 45 с) — приложение не загрузилось. Пока это тишина: страница висит (или висит
 * пустой экран), а Sentry молчит — клиентский SDK не поднялся, ведь приложение не стартовало.
 *
 * Контракт события. Guard диспатчит window CustomEvent 'app:load-timeout' с detail
 * `{ reason: 'load-timeout', timeoutMs, elapsedMs, url?, kind? }`:
 *   - timeoutMs — сколько ждали (значение watchdog'а);
 *   - elapsedMs — сколько реально прошло;
 *   - kind — что не загрузилось ('chunk' | 'entry'), если watchdog видел сбой;
 *   - url — адрес не загрузившегося скрипта, если watchdog его знает.
 *
 * Кто отправляет. ТОЛЬКО ранний beacon (early-beacon.ts): к моменту таймера клиентский SDK может быть не поднят
 * (приложение не стартовало — это и есть смысл watchdog'а), а при поднятом SDK второй отправитель дал бы дубль.
 * Поэтому SDK-путь (plugin.client.ts) это событие не слушает и не отправляет.
 *
 * Семейство отдельное от `app:chunk-reload-blocked`: свой fingerprint ('app-load-timeout'), свои теги ('load.*')
 * и свой контекст ('load'). Общая с остальными отчётами только форма события.
 *
 * Модуль не зависит от рантайма Sentry: событие строит чистая функция, а ранний inline-beacon вшивает те же
 * части заголовка в свой скрипт при сборке и дописывает в ES5-скрипте то, что известно только в браузере.
 */

export const LOAD_TIMEOUT_EVENT = 'app:load-timeout'

/* Fingerprint: одна issue на watchdog (в отличие от семейства chunk-reload-blocked — там причина и kind). */
export const LOAD_TIMEOUT_FINGERPRINT = 'app-load-timeout'

export const LOAD_TIMEOUT_LEVEL = 'error'

/* Что не загрузилось, если watchdog видел сбой до таймаута. */
export const LOAD_TIMEOUT_KINDS = ['chunk', 'entry'] as const

export type LoadTimeoutKind = (typeof LOAD_TIMEOUT_KINDS)[number]

export interface LoadTimeoutDetail {
  reason: 'load-timeout'
  timeoutMs: number
  elapsedMs: number
  url?: string
  kind?: LoadTimeoutKind
}

/*
 * Части заголовка issue — отдельными константами, потому что их собирает и SDK-путь (здесь), и ES5-скрипт
 * раннего beacon'а: кириллица в тексте скрипта запрещена, а заголовок issue — русский.
 */
export const LOAD_TIMEOUT_MESSAGE_PREFIX = 'Приложение не загрузилось за '
export const LOAD_TIMEOUT_MESSAGE_SUFFIX = ' с'
export const LOAD_TIMEOUT_MESSAGE_GENERIC = 'Приложение не загрузилось'

/* Лимит значения тега Sentry — 200 символов; текст в контексте — 2000 (как maxValueLength у init). */
const CONTEXT_TEXT_LIMIT = 2000

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

/*
 * Sentry-событие по detail watchdog'а. Detail приходит из другой ревизии guard'а, поэтому каждое поле
 * проверяется по типу: лишнее/битое значение — просто не попадает в отчёт, а не ломает его.
 */
export function toLoadTimeoutEvent(detail: LoadTimeoutDetail): Event {
  const tags: Record<string, string> = {}
  const load: Record<string, unknown> = {}

  if (typeof detail.timeoutMs === 'number' && Number.isFinite(detail.timeoutMs)) {
    tags['load.timeoutMs'] = String(detail.timeoutMs)
    load.timeoutMs = detail.timeoutMs
  }
  if (typeof detail.elapsedMs === 'number' && Number.isFinite(detail.elapsedMs)) {
    tags['load.elapsedMs'] = String(detail.elapsedMs)
    load.elapsedMs = detail.elapsedMs
  }
  if (detail.kind !== undefined && LOAD_TIMEOUT_KINDS.some((kind) => kind === detail.kind)) {
    tags['load.kind'] = detail.kind
    load.kind = detail.kind
  }
  if (typeof detail.url === 'string' && detail.url !== '') {
    load.url = clip(detail.url, CONTEXT_TEXT_LIMIT)
  }

  return {
    message: loadTimeoutMessage(detail.timeoutMs),
    level: LOAD_TIMEOUT_LEVEL,
    fingerprint: [LOAD_TIMEOUT_FINGERPRINT],
    tags,
    contexts: { load },
  }
}
