import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureExceptionMock = vi.fn()
const setExtrasMock = vi.fn()
const setTagsMock = vi.fn()
// oxlint-disable-next-line promise/prefer-await-to-callbacks -- mock factory callback for vi.fn, not a promise callback
const withScopeMock = vi.fn((cb: (scope: { setExtras: typeof setExtrasMock; setTags: typeof setTagsMock }) => void) => {
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- invoking the captured callback synchronously in test double
  cb({ setExtras: setExtrasMock, setTags: setTagsMock })
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
    setTagsMock.mockClear()
  })

  it('форвардит unhandled raw-ошибку (без statusCode) с url/method в extras', () => {
    const error = new Error('boom')
    captureNitroError(error, { event: { path: '/api/foo', method: 'GET' } })

    expect(captureExceptionMock).toHaveBeenCalledOnce()
    const [errArg, hint] = captureExceptionMock.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(errArg).toBe(error)
    expect(hint).toMatchObject({ mechanism: { handled: false, type: 'nitro' } })
    expect(setExtrasMock).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/foo', method: 'GET' }))
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
    expect(setExtrasMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'Unknown URL', method: 'Unknown Method' }),
    )
  })

  it("НЕ шлёт ошибку 'Cannot find static asset' (Nuxt 404 на missing asset — шум)", () => {
    const error = new Error('Cannot find static asset /_nuxt/foo.js')
    captureNitroError(error, { event: { path: '/_nuxt/foo.js', method: 'GET' } })
    expect(captureExceptionMock).not.toHaveBeenCalled()
    expect(withScopeMock).not.toHaveBeenCalled()
  })
})

describe('captureNitroError — filter + enricher', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear()
    setExtrasMock.mockClear()
    withScopeMock.mockClear()
    setTagsMock.mockClear()
  })

  it('пропускает событие если filter возвращает false', () => {
    const filter = vi.fn().mockReturnValue(false)
    const enricher = vi.fn().mockReturnValue({})
    captureNitroError(new Error('skipped'), { event: { path: '/x', method: 'GET' } }, { filter, enricher })
    expect(filter).toHaveBeenCalledOnce()
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('пропускает событие на дефолтных опциях (filter=true) если 4xx', () => {
    const filter = vi.fn().mockReturnValue(true)
    const enricher = vi.fn().mockReturnValue({})
    const error = Object.assign(new Error('forbidden'), { statusCode: 403 })
    captureNitroError(error, { event: { path: '/x', method: 'GET' } }, { filter, enricher })
    expect(captureExceptionMock).not.toHaveBeenCalled()
    expect(filter).not.toHaveBeenCalled()
  })

  it("enricher merge: extras enricher'а попадают в setExtras поверх default + buildSentryReport", () => {
    const filter = vi.fn().mockReturnValue(true)
    const enricher = vi.fn().mockReturnValue({ extra: { custom: 'value' }, tags: { kind: 'upstream' } })
    const error = Object.assign(new Error('upstream 500'), {
      data: { code: 'E_X' },
      cause: { name: 'AWSError', message: 'denied' },
    })
    const event = { node: { req: { url: '/api/x', method: 'POST', headers: { a: 'b' } } } }

    captureNitroError(error, { event } as never, { filter, enricher })

    expect(setExtrasMock).toHaveBeenCalledOnce()
    const [extras] = setExtrasMock.mock.calls[0] as [Record<string, unknown>]
    expect(extras).toMatchObject({
      url: '/api/x',
      method: 'POST',
      appData: { code: 'E_X' },
      custom: 'value',
    })
    expect(extras.cause).toMatchObject({ name: 'AWSError', message: 'denied' })

    expect(captureExceptionMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ mechanism: { handled: false, type: 'nitro' } }),
    )
  })

  it('без options — работает как раньше (legacy compat)', () => {
    const error = new Error('boom')
    captureNitroError(error, { event: { path: '/x', method: 'GET' } })
    expect(captureExceptionMock).toHaveBeenCalledOnce()
    expect(setExtrasMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/x',
        method: 'GET',
      }),
    )
  })
})
