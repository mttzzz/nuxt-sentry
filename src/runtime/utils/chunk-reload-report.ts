import type { Event } from '@sentry/core'

import { clip } from './clip'

/*
 * Отчёт в Sentry о сбое загрузки чанка, который @mttzzz/nuxt-stale-deploy-guard проглотил и после
 * которого перезагрузки НЕ будет. Guard сообщает о таком исходе событием window `app:chunk-reload-blocked`
 * (CustomEvent, detail — объединение по reason).
 *
 * Зачем. ai.pushka.biz, 15.10.2026: iPhone на iOS 16.0.2 (WebKit без import maps) открывал инвайт и
 * получал `500 Module specifier '#entry' …`. Цепочка тишины: (1) Vite шлёт vite:preloadError, guard
 * всегда делает preventDefault() — импорт резолвится в undefined; (2) vue-router бросает «Couldn't
 * resolve component …», и ignoreErrors (STALE_CHUNK_PATTERNS) дропает все захваты; (3) guard делает
 * HEAD-пробы, build-id совпал — ничего. Юзер на ошибке, в Sentry ноль. Теперь каждый такой исход —
 * одно событие на reason за загрузку страницы.
 *
 * Отдельный исход `retry-failed` (guard ≥ 0.6.0) — сбой загрузки страницы ДО app:mounted. Тут guard
 * не сверяет build-id: он один раз сам перезагружает страницу (маркер `sdg-retry` в URL), а если сбой
 * повторился, показывает экран «Страница не загрузилась» и диспатчит это событие. `kind` — что не
 * загрузилось: `chunk` (чанк страницы, динамический импорт) или `entry` (`<script type="module">`
 * точки входа). Шлёт его ТОЛЬКО ранний beacon (early-beacon.ts): он работает и до инициализации SDK,
 * а второй отправитель при поднятом SDK дал бы дубль — поэтому reporter SDK-пути `retry-failed`
 * игнорирует. Fingerprint у него по причине и kind: сбой entry и сбой чанка — разные issue.
 *
 * Исходная ошибка уходит НЕ как exception/cause: её текст совпадает с STALE_CHUNK_PATTERNS, и
 * ignoreErrors срежет отчёт тем же способом, что обнулил репорты в инциденте. Она лежит только в
 * contexts.chunk.error и в теге chunk.error. Тег chunk.reason — ещё и маркер для beforeSend: событие
 * обходит staleChunkFilter (его 5-секундное breadcrumb-окно видит свежий console.error про тот же
 * чанк и срезало бы отчёт).
 *
 * Тип detail — свой, структурный: у пакета закреплена конкретная ревизия guard, и типа события в ней
 * может не быть или он может отличаться. Модуль не зависит от рантайма Sentry: событие строится чистой
 * функцией, а ранний inline-beacon (early-beacon.ts) вшивает тот же шаблон в свой скрипт при сборке.
 */

export const CHUNK_RELOAD_BLOCKED_EVENT = 'app:chunk-reload-blocked'

/* Тег-маркер: по нему beforeSend пропускает событие мимо staleChunkFilter. */
export const CHUNK_REASON_TAG = 'chunk.reason'

export interface UnsupportedBrowserDetail {
  reason: 'unsupported-browser'
  missing: string
}

export interface NotStaleDetail {
  reason: 'not-stale'
  error?: unknown
  probes: string[]
  buildId: string
}

export interface CircuitBreakerDetail {
  reason: 'circuit-breaker'
  error?: unknown
  probes: string[]
  buildId: string
  attempts: number
  windowMs: number
}

export interface CooldownDetail {
  reason: 'cooldown'
  error?: unknown
  buildId: string
}

export interface NoBuildIdDetail {
  reason: 'no-build-id'
  error?: unknown
}

/* Что не загрузилось при `retry-failed`: чанк страницы или entry. */
export const RETRY_FAILED_KINDS = ['chunk', 'entry'] as const

export type RetryFailedKind = (typeof RETRY_FAILED_KINDS)[number]

export interface RetryFailedDetail {
  reason: 'retry-failed'
  kind: RetryFailedKind
  error?: unknown
  /* Адрес скрипта, который не загрузился (для kind `entry`), если guard его знает. */
  url?: string
}

export type ChunkReloadBlockedDetail =
  | UnsupportedBrowserDetail
  | NotStaleDetail
  | CircuitBreakerDetail
  | CooldownDetail
  | NoBuildIdDetail
  | RetryFailedDetail

export type ChunkReloadBlockedReason = ChunkReloadBlockedDetail['reason']

/* Заголовки issue (Sentry титулует message-событие его текстом). Ни один не матчится ignoreErrors. */
const TITLES: Record<ChunkReloadBlockedReason, string> = {
  'unsupported-browser': 'Браузер без import maps',
  'not-stale': 'Чанк не загрузился, билд актуален',
  'circuit-breaker': 'Чанк не загрузился, перезагрузки исчерпаны',
  cooldown: 'Чанк не загрузился сразу после перезагрузки',
  'no-build-id': 'Чанк не загрузился, build-id неизвестен',
  'retry-failed': 'Страница не загрузилась и после перезагрузки',
}

const REASONS: readonly string[] = Object.keys(TITLES)

/* Лимит значения тега Sentry — 200 символов; текст в контексте — 2000 (как maxValueLength у init). */
const TAG_VALUE_LIMIT = 200
const CONTEXT_TEXT_LIMIT = 2000

/* Поля detail, которые читает маппинг: guard приходит из другой ревизии, поэтому каждое проверяется по типу. */
interface DetailFields {
  error?: unknown
  probes?: unknown
  buildId?: unknown
  attempts?: unknown
  windowMs?: unknown
  missing?: unknown
  url?: unknown
}

interface ChunkErrorSummary {
  name?: string
  message: string
  stack?: string
}

export function isChunkReloadBlockedDetail(value: unknown): value is ChunkReloadBlockedDetail {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('reason' in value) ||
    typeof value.reason !== 'string' ||
    !REASONS.includes(value.reason)
  ) {
    return false
  }
  /* У retry-failed kind обязателен: без него нечем отличить сбой entry от сбоя чанка (fingerprint, тег). */
  return value.reason !== 'retry-failed' || ('kind' in value && RETRY_FAILED_KINDS.some((kind) => kind === value.kind))
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    const json: string | undefined = JSON.stringify(value)
    if (json !== undefined) {
      return json
    }
  } catch {
    /* Циклическая структура или BigInt — ниже String(). */
  }
  return String(value)
}

/*
 * Исходная ошибка — что угодно: Error, строка, ErrorEvent, undefined. Чтение свойств произвольного
 * объекта может бросить (геттер, отозванный Proxy) — тогда отчёт уходит без сведений об ошибке, а не
 * теряется целиком.
 */
function summarizeError(error: unknown): ChunkErrorSummary | undefined {
  if (error === undefined || error === null) {
    return undefined
  }
  try {
    if (typeof error !== 'object') {
      return { message: clip(stringifyUnknown(error), CONTEXT_TEXT_LIMIT) }
    }
    const name = 'name' in error ? error.name : undefined
    const message = 'message' in error ? error.message : undefined
    const stack = 'stack' in error ? error.stack : undefined
    const summary: ChunkErrorSummary = {
      message: clip(typeof message === 'string' ? message : stringifyUnknown(error), CONTEXT_TEXT_LIMIT),
    }
    if (typeof name === 'string' && name !== '') {
      summary.name = name
    }
    if (typeof stack === 'string' && stack !== '') {
      summary.stack = clip(stack, CONTEXT_TEXT_LIMIT)
    }
    return summary
  } catch {
    return undefined
  }
}

/*
 * Sentry-событие по detail: одинаково для SDK-пути (Sentry.captureEvent в plugin.client.ts) и для
 * раннего beacon (шаблон события вшивается в его скрипт при сборке). level: warning для
 * unsupported-browser (проблема браузера, а не приложения), error для остальных; fingerprint —
 * одна issue на причину (у retry-failed — на причину и kind).
 */
export function toChunkReloadBlockedEvent(detail: ChunkReloadBlockedDetail): Event {
  const fields: DetailFields = detail
  const tags: Record<string, string> = { [CHUNK_REASON_TAG]: detail.reason }
  const chunk: Record<string, unknown> = { reason: detail.reason }
  const fingerprint: string[] = ['chunk-reload-blocked', detail.reason]

  if (detail.reason === 'retry-failed') {
    tags['chunk.kind'] = detail.kind
    chunk.kind = detail.kind
    fingerprint.push(detail.kind)
  }

  const error = summarizeError(fields.error)
  if (error !== undefined) {
    chunk.error = error
    /* Значение тега — одна строка: перевод строки Sentry в теге не принимает. */
    const text = clip(error.message.replaceAll(/\s+/gu, ' ').trim(), TAG_VALUE_LIMIT)
    if (text !== '') {
      tags['chunk.error'] = text
    }
  }
  if (typeof fields.missing === 'string' && fields.missing !== '') {
    tags['chunk.missing'] = fields.missing
  }
  if (Array.isArray(fields.probes)) {
    chunk.probes = fields.probes.filter((probe): probe is string => typeof probe === 'string')
  }
  if (typeof fields.buildId === 'string') {
    chunk.buildId = fields.buildId
  }
  if (typeof fields.attempts === 'number' && Number.isFinite(fields.attempts)) {
    chunk.attempts = fields.attempts
  }
  if (typeof fields.windowMs === 'number' && Number.isFinite(fields.windowMs)) {
    chunk.windowMs = fields.windowMs
  }
  if (typeof fields.url === 'string' && fields.url !== '') {
    chunk.url = clip(fields.url, CONTEXT_TEXT_LIMIT)
  }

  return {
    message: TITLES[detail.reason],
    level: detail.reason === 'unsupported-browser' ? 'warning' : 'error',
    fingerprint,
    tags,
    contexts: { chunk },
  }
}

/* Событие этого отчёта — по тегу-маркеру; beforeSend не прогоняет такое через staleChunkFilter. */
export function isChunkReloadBlockedEvent(event: Event): boolean {
  return event.tags?.[CHUNK_REASON_TAG] !== undefined
}

/*
 * Обработчик события window: одно сообщение на reason за загрузку страницы (guard может повторять
 * исход на каждую следующую ошибку чанка — issue на причину от этого не растёт, а квота не тратится).
 * Невалидный detail молча игнорируется: слушатель события не должен бросать. `retry-failed` тоже
 * игнорируется: его шлёт только ранний beacon (early-beacon.ts) — он срабатывает и до инициализации
 * SDK, а при поднятом SDK второй отправитель дал бы дубль.
 */
export function createChunkReloadBlockedReporter(capture: (event: Event) => void): (detail: unknown) => void {
  const reported = new Set<ChunkReloadBlockedReason>()
  return (detail) => {
    if (!isChunkReloadBlockedDetail(detail) || detail.reason === 'retry-failed' || reported.has(detail.reason)) {
      return
    }
    reported.add(detail.reason)
    capture(toChunkReloadBlockedEvent(detail))
  }
}

/*
 * Подписка SDK-пути на window-событие guard'а. Отдельная функция, а не код в plugin.client.ts: плагин тянет
 * '#app' и в unit-тест не импортируется, а контракт «SDK-путь реагирует ТОЛЬКО на 'app:chunk-reload-blocked'»
 * проверяется тестом — в том числе что watchdog'а ('app:load-timeout') он не отправляет: тот шлёт только
 * ранний beacon (early-beacon.ts), иначе при поднятом SDK было бы два события.
 *
 * `target` — куда вешается слушатель (по умолчанию window). Параметр ради теста: в Node у globalThis нет
 * addEventListener, а контракт подписки проверяется на подставном таргете.
 *
 * Возвращает функцию отписки — ею тест чистит подписку.
 */
export function listenChunkReloadBlocked(
  capture: (event: Event) => void,
  target: {
    addEventListener: (type: string, listener: (event: Event) => void) => void
    removeEventListener: (type: string, listener: (event: Event) => void) => void
  } = globalThis,
): () => void {
  const report = createChunkReloadBlockedReporter(capture)
  function handler(event: Event): void {
    report((event as CustomEvent<unknown>).detail)
  }
  target.addEventListener(CHUNK_RELOAD_BLOCKED_EVENT, handler)
  return () => {
    target.removeEventListener(CHUNK_RELOAD_BLOCKED_EVENT, handler)
  }
}
