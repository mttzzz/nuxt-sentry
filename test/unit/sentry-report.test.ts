import { describe, expect, it } from 'vitest'

import { buildSentryReport } from '../../src/runtime/utils/sentry-report'

function makeEvent(url: string, method: string, headers: Record<string, string> = {}) {
  return { node: { req: { url, method, headers } } } as never
}

describe('buildSentryReport', () => {
  it('базовые extras (url/method/headers) + tag source=nitro-error-hook', () => {
    const error = { message: 'boom' }
    const result = buildSentryReport(error, makeEvent('/api/x', 'POST', { 'x-foo': 'bar' }))
    expect(result.tags).toEqual({ source: 'nitro-error-hook' })
    expect(result.extra).toMatchObject({
      url: '/api/x',
      method: 'POST',
    })
    expect(typeof result.extra.headers).toBe('string')
  })

  it('extra.headers: cookie сессии и authorization маскируются, остальные заголовки как были', () => {
    const result = buildSentryReport(
      { message: 'boom' },
      makeEvent('/api/x', 'POST', {
        cookie: 'better-auth.session_token=abc.def; theme=dark',
        authorization: 'Bearer client-token',
        'x-forwarded-for': '203.0.113.9',
        'user-agent': 'Mozilla/5.0',
      }),
    )
    expect(JSON.parse(String(result.extra.headers))).toEqual({
      cookie: '[Filtered]',
      authorization: '[Filtered]',
      'x-forwarded-for': '203.0.113.9',
      'user-agent': 'Mozilla/5.0',
    })
    expect(String(result.extra.headers)).not.toContain('abc.def')
    expect(String(result.extra.headers)).not.toContain('client-token')
  })

  it('без event — defaults Unknown URL/Method', () => {
    const result = buildSentryReport({ message: 'x' })
    expect(result.extra).toMatchObject({ url: 'Unknown URL', method: 'Unknown Method', headers: 'No headers' })
  })

  it('включает error.data как appData (h3 createError data)', () => {
    const error = { data: { code: 'E_AUTH', details: { reason: 'expired' } } }
    const result = buildSentryReport(error)
    expect(result.extra.appData).toEqual({ code: 'E_AUTH', details: { reason: 'expired' } })
  })

  it('error.data не object — пропускается', () => {
    const result = buildSentryReport({ data: 'string-data' as never })
    expect(result.extra.appData).toBeUndefined()
  })

  it('summarizeCause: AWS-style объект с $metadata.httpStatusCode', () => {
    const error = {
      cause: {
        name: 'InvalidAccessKeyId',
        message: 'access denied',
        $metadata: { httpStatusCode: 403 },
        stack: 'Error: at...',
      },
    }
    const result = buildSentryReport(error)
    expect(result.extra.cause).toEqual({
      name: 'InvalidAccessKeyId',
      message: 'access denied',
      httpStatusCode: 403,
      stack: 'Error: at...',
    })
  })

  it('cause: string — passthrough', () => {
    const result = buildSentryReport({ cause: 'just a string' })
    expect(result.extra.cause).toBe('just a string')
  })

  it('cause: null — не включается', () => {
    const result = buildSentryReport({ cause: null })
    expect(result.extra.cause).toBeUndefined()
  })
})
