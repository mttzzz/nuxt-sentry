import * as Sentry from '@sentry/bun'

import { buildSentryReport } from './sentry-report'

/*
 * Pure handler для nitro error-hook — форвардит ошибку в Sentry.
 *
 * @sentry/bun ловит только process-level uncaught exceptions, а nitro перехватывает
 * ошибки хендлеров внутри request-pipeline и сам конвертит в 500 + лог
 * `[request error] [unhandled]`. Без явного хука 5xx из server/api/* в Sentry не доходят.
 *
 * Default-фильтрация: 4xx (createError H3Error 401/403/404/422) — ожидаемые
 * user-facing ошибки, в Sentry не шлём, иначе шум.
 *
 * Расширения через options:
 *   - filter(error)  → return false → событие пропускается (после 4xx-skip).
 *     Use case: ai's "Cannot find static asset" skip.
 *   - enricher(error, event) → { extra?, tags? } merge'ится поверх default
 *     buildSentryReport (url/method/headers/cause/appData).
 *     Use case: project-specific дополнительный контекст.
 */

/* Структурное подмножество nitro CapturedErrorContext (event?: H3Event): headers у IncomingMessage —
   IncomingHttpHeaders, значения string | string[] | undefined. */
interface NitroErrorContext {
  event?: {
    path?: string
    method?: string
    node?: { req?: { url?: string; method?: string; headers?: Record<string, string | string[] | undefined> } }
  }
}

export interface CaptureNitroErrorOptions {
  filter?: (error: unknown) => boolean
  enricher?: (error: unknown, event?: unknown) => { extra?: Record<string, unknown>; tags?: Record<string, string> }
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number') {
      return value
    }
  }
  return undefined
}

function getErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = (error as { message?: unknown }).message
    if (typeof value === 'string') {
      return value
    }
  }
  return undefined
}

export function captureNitroError(
  error: unknown,
  context: NitroErrorContext,
  options?: CaptureNitroErrorOptions,
): void {
  const statusCode = getStatusCode(error)
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return
  }

  /*
   * Nuxt бросает 'Cannot find static asset ...' на любой 404 для /_nuxt/* или
   * /public/*. У продакшна это шум от stale-hash в браузерах после деплоя —
   * не actionable, в Sentry не репортим. Skip применяется ко всем проектам.
   */
  const message = getErrorMessage(error)
  if (message?.includes('Cannot find static asset')) {
    return
  }

  const { filter, enricher } = options ?? {}
  if (filter !== undefined && !filter(error)) {
    return
  }

  const errorLike = (typeof error === 'object' && error !== null ? error : {}) as Parameters<
    typeof buildSentryReport
  >[0]
  const baseReport = buildSentryReport(errorLike, context.event as never)

  /*
   * Backwards compat: if event only has the simple { path, method } shape
   * (old NitroErrorContext before H3Event was supported), override the
   * 'Unknown URL' / 'Unknown Method' fallbacks from buildSentryReport.
   */
  const { event } = context
  if (event?.path !== undefined) {
    baseReport.extra.url = event.path
  }
  if (event?.method !== undefined) {
    baseReport.extra.method = event.method
  }

  const enrichment = enricher?.(error, context.event) ?? {}
  const extras = { ...baseReport.extra, ...enrichment.extra }
  const tags = { ...baseReport.tags, ...enrichment.tags }
  const tagKeys = Object.keys(tags)

  Sentry.withScope((scope) => {
    scope.setExtras(extras)
    if (tagKeys.length > 0) {
      scope.setTags(tags)
    }
    Sentry.captureException(error, {
      mechanism: { handled: false, type: 'nitro' },
    })
  })
}
