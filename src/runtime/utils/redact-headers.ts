/*
 * Маскировка секретов в заголовках, которые модуль кладёт в `extra` САМ (buildSentryReport →
 * `extra.headers`). SDK маскирует свои `request.headers` и `request.cookies` сам, но `extra.headers` —
 * строка JSON с сырыми заголовками nitro-события: на 10.x и 11 туда попадали `cookie` с сессией и
 * `authorization` как есть, и серверный скраббер Sentry ключи внутри строки не видит.
 *
 * Список совпадает с `SENSITIVE_KEY_SNIPPETS` из @sentry/core 11 (`filtering-snippets`): `extra.headers`
 * маскирует ровно то, что SDK маскирует в `request.headers`. Сверка — по вхождению подстроки в имя
 * заголовка без учёта регистра.
 */
export const FILTERED_VALUE = '[Filtered]'

const SENSITIVE_HEADER_SNIPPETS = [
  'auth',
  'token',
  'secret',
  'session',
  'password',
  'passwd',
  'pwd',
  'key',
  'jwt',
  'bearer',
  'sso',
  'saml',
  'csrf',
  'xsrf',
  'credentials',
  'sid',
  'identity',
  'set-cookie',
  'cookie',
] as const

export type HeaderValue = string | string[] | undefined

export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_HEADER_SNIPPETS.some((snippet) => lower.includes(snippet))
}

export function redactHeaders(headers: Readonly<Record<string, HeaderValue>>): Record<string, HeaderValue> {
  const redacted: Record<string, HeaderValue> = {}
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = value !== undefined && isSensitiveHeaderName(name) ? FILTERED_VALUE : value
  }
  return redacted
}
