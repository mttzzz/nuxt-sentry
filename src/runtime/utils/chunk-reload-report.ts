import type { Event } from '@sentry/core'

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

export type ChunkReloadBlockedDetail =
  | UnsupportedBrowserDetail
  | NotStaleDetail
  | CircuitBreakerDetail
  | CooldownDetail
  | NoBuildIdDetail

export type ChunkReloadBlockedReason = ChunkReloadBlockedDetail['reason']

/* Заголовки issue (Sentry титулует message-событие его текстом). Ни один не матчится ignoreErrors. */
const TITLES: Record<ChunkReloadBlockedReason, string> = {
  'unsupported-browser': 'Браузер без import maps',
  'not-stale': 'Чанк не загрузился, билд актуален',
  'circuit-breaker': 'Чанк не загрузился, перезагрузки исчерпаны',
  cooldown: 'Чанк не загрузился сразу после перезагрузки',
  'no-build-id': 'Чанк не загрузился, build-id неизвестен',
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
}

interface ChunkErrorSummary {
  name?: string
  message: string
  stack?: string
}

export function isChunkReloadBlockedDetail(value: unknown): value is ChunkReloadBlockedDetail {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    REASONS.includes(value.reason)
  )
}

/* Обрезка без половины суррогатной пары: одинокий суррогат делает JSON-строку невалидной для разбора на сервере. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }
  const cut = text.slice(0, limit)
  const last = cut.codePointAt(limit - 1) ?? 0
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
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
 * одна issue на причину.
 */
export function toChunkReloadBlockedEvent(detail: ChunkReloadBlockedDetail): Event {
  const fields: DetailFields = detail
  const tags: Record<string, string> = { [CHUNK_REASON_TAG]: detail.reason }
  const chunk: Record<string, unknown> = { reason: detail.reason }

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

  return {
    message: TITLES[detail.reason],
    level: detail.reason === 'unsupported-browser' ? 'warning' : 'error',
    fingerprint: ['chunk-reload-blocked', detail.reason],
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
 * Невалидный detail молча игнорируется: слушатель события не должен бросать.
 */
export function createChunkReloadBlockedReporter(capture: (event: Event) => void): (detail: unknown) => void {
  const reported = new Set<ChunkReloadBlockedReason>()
  return (detail) => {
    if (!isChunkReloadBlockedDetail(detail) || reported.has(detail.reason)) {
      return
    }
    reported.add(detail.reason)
    capture(toChunkReloadBlockedEvent(detail))
  }
}
