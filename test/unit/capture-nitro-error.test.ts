import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureExceptionMock = vi.fn()
const setExtrasMock = vi.fn()
// oxlint-disable-next-line promise/prefer-await-to-callbacks -- mock factory callback for vi.fn, not a promise callback
const withScopeMock = vi.fn((cb: (scope: { setExtras: typeof setExtrasMock }) => void) => {
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- invoking the captured callback synchronously in test double
  cb({ setExtras: setExtrasMock })
})

vi.mock('@sentry/bun', () => ({
  captureException: captureExceptionMock,
  withScope: withScopeMock,
}))

const { captureNitroError } = await import('../../src/runtime/utils/capture-nitro-error')

describe('captureNitroError', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear()
    setExtrasMock.mockClear()
    withScopeMock.mockClear()
  })

  it('форвардит unhandled raw-ошибку (без statusCode) с url/method в extras', () => {
    const error = new Error('boom')
    captureNitroError(error, { event: { path: '/api/foo', method: 'GET' } })

    expect(captureExceptionMock).toHaveBeenCalledOnce()
    const [errArg, hint] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(errArg).toBe(error)
    expect(hint).toMatchObject({ mechanism: { handled: false, type: 'nitro' } })
    expect(setExtrasMock).toHaveBeenCalledWith({ url: '/api/foo', method: 'GET' })
  })

  it('форвардит 5xx H3-ошибку (statusCode 500)', () => {
    const error = Object.assign(new Error('Driver error'), { statusCode: 500 })
    captureNitroError(error, { event: { path: '/api/x', method: 'POST' } })
    expect(captureExceptionMock).toHaveBeenCalledOnce()
  })

  it('НЕ шлёт 4xx (forbidden/notFound/validation)', () => {
    const forbidden = Object.assign(new Error('forbidden'), { statusCode: 403 })
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 })
    const validation = Object.assign(new Error('validation'), { statusCode: 422 })

    captureNitroError(forbidden, { event: { path: '/api/a', method: 'GET' } })
    captureNitroError(notFound, { event: { path: '/api/b', method: 'GET' } })
    captureNitroError(validation, { event: { path: '/api/c', method: 'POST' } })

    expect(captureExceptionMock).not.toHaveBeenCalled()
    expect(withScopeMock).not.toHaveBeenCalled()
  })

  it('работает без event в context', () => {
    const error = new Error('boot error')
    captureNitroError(error, {})
    expect(captureExceptionMock).toHaveBeenCalledOnce()
    expect(setExtrasMock).toHaveBeenCalledWith({ url: undefined, method: undefined })
  })
})
