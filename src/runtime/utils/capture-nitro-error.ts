import * as Sentry from '@sentry/bun'

/*
 * Чистый хендлер для nitro-хука `error` — форвардит ошибку в Sentry.
 *
 * `@sentry/bun` ловит только process-level uncaught exceptions, а nitro перехватывает
 * ошибки хендлеров внутри request-pipeline и сам конвертит их в 500 + лог
 * `[request error] [unhandled]`. Без явного хука 5xx из server/api/* в Sentry не доходят.
 *
 * Фильтрация:
 *   - 4xx (createError / H3Error: 401/403/404/422) — это ожидаемые user-facing
 *     ошибки, в Sentry не шлём, иначе зашумим issue-лист.
 *   - Всё остальное (5xx + raw JS-ошибки без statusCode) — captureException.
 *
 * Sentry-API нюанс: второй аргумент `captureException` — exclusive union
 * EventHint XOR ScopeContext. `mechanism` живёт в EventHint, `extra` в
 * ScopeContext, поэтому extras прокидываем через withScope.
 */

interface NitroErrorContext {
  event?: {
    path?: string
    method?: string
  }
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number') { return value }
  }
  return undefined
}

export function captureNitroError(error: unknown, context: NitroErrorContext): void {
  const statusCode = getStatusCode(error)
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return
  }

  Sentry.withScope((scope) => {
    scope.setExtras({
      url: context.event?.path,
      method: context.event?.method,
    })
    Sentry.captureException(error, {
      mechanism: { handled: false, type: 'nitro' },
    })
  })
}
