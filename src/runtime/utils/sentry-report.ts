import type { H3Event } from 'h3'

interface NitroErrorLike {
  cause?: unknown
  data?: unknown
  message?: string
  statusCode?: number
}

export interface SentryReport {
  extra: Record<string, unknown>
  tags: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/*
 * Чистая функция: вытаскиваем из ошибки и H3-event всё, что Sentry должен
 * показать в карточке. Главное — error.data (наш AppErrorData с code/details/causeId)
 * и error.cause (исходная AWS/upstream-ошибка). Без этого sendWithRetry-wrap
 * прячет реальный InvalidAccessKeyId / 5xx в Хранилище-сообщении.
 */
export function buildSentryReport(error: NitroErrorLike, event?: H3Event): SentryReport {
  const url = event?.node?.req?.url ?? 'Unknown URL'
  const method = event?.node?.req?.method ?? 'Unknown Method'
  const headers = event?.node?.req?.headers ? JSON.stringify(event.node.req.headers) : 'No headers'

  const extra: Record<string, unknown> = { url, method, headers }
  if (isRecord(error.data)) {
    extra.appData = error.data
  }
  if (error.cause !== undefined && error.cause !== null) {
    extra.cause = summarizeCause(error.cause)
  }

  return {
    extra,
    tags: { source: 'nitro-error-hook' },
  }
}

function summarizeCause(cause: unknown): Record<string, unknown> | string {
  if (!isRecord(cause)) {
    return typeof cause === 'string' ? cause : String(cause)
  }
  const summary: Record<string, unknown> = {}
  if (typeof cause.name === 'string') {
    summary.name = cause.name
  }
  if (typeof cause.message === 'string') {
    summary.message = cause.message
  }
  if (isRecord(cause.$metadata) && typeof cause.$metadata.httpStatusCode === 'number') {
    summary.httpStatusCode = cause.$metadata.httpStatusCode
  }
  if (typeof cause.stack === 'string') {
    summary.stack = cause.stack
  }
  return summary
}
