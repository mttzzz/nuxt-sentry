import { describe, expect, it } from 'vitest'

import { FILTERED_VALUE, isSensitiveHeaderName, redactHeaders } from '../../src/runtime/utils/redact-headers'

describe('isSensitiveHeaderName', () => {
  it.each([
    'authorization',
    'Authorization',
    'proxy-authorization',
    'cookie',
    'COOKIE',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
    'x-xsrf-token',
    'x-session-id',
    'x-amz-security-token',
    'idempotency-key',
    'x-client-secret',
  ])('%s — секрет', (name) => {
    expect(isSensitiveHeaderName(name)).toBe(true)
  })

  it.each([
    'user-agent',
    'x-forwarded-for',
    'x-forwarded-proto',
    'host',
    'accept',
    'accept-language',
    'accept-encoding',
    'content-type',
    'content-length',
    'referer',
    'origin',
    'connection',
    'x-request-id',
  ])('%s — обычный заголовок', (name) => {
    expect(isSensitiveHeaderName(name)).toBe(false)
  })
})

describe('redactHeaders', () => {
  it('значения секретов — [Filtered], остальное как есть', () => {
    expect(
      redactHeaders({
        cookie: 'better-auth.session_token=abc; theme=dark',
        authorization: 'Bearer abc',
        'user-agent': 'Mozilla/5.0',
        'x-forwarded-for': '203.0.113.9',
      }),
    ).toEqual({
      cookie: FILTERED_VALUE,
      authorization: FILTERED_VALUE,
      'user-agent': 'Mozilla/5.0',
      'x-forwarded-for': '203.0.113.9',
    })
  })

  it('массив set-cookie заменяется одним маркером, массив обычного заголовка сохраняется', () => {
    expect(redactHeaders({ 'set-cookie': ['a=1', 'b=2'], 'accept-language': ['ru', 'en'] })).toEqual({
      'set-cookie': FILTERED_VALUE,
      'accept-language': ['ru', 'en'],
    })
  })

  it('undefined-значение секрета остаётся undefined (нечего маскировать)', () => {
    expect(redactHeaders({ authorization: undefined })).toEqual({ authorization: undefined })
  })

  it('входной объект не мутируется', () => {
    const headers = { cookie: 'a=1', host: 'example.com' }
    const redacted = redactHeaders(headers)
    expect(redacted).not.toBe(headers)
    expect(headers).toEqual({ cookie: 'a=1', host: 'example.com' })
  })
})
