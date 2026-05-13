import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureExceptionMock = vi.fn()
const addBreadcrumbMock = vi.fn()

vi.mock('@sentry/vue', () => ({
  captureException: captureExceptionMock,
  addBreadcrumb: addBreadcrumbMock,
}))

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

const { createLogger } = await import('../../src/runtime/utils/client-logger')

describe('client createLogger', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear()
    addBreadcrumbMock.mockClear()
    consoleErrorSpy.mockClear()
    consoleWarnSpy.mockClear()
  })

  it('error() captures Error из args с тегом source', () => {
    const log = createLogger('profile')
    const err = new Error('boom')
    log.error('загрузка не удалась', err)
    expect(captureExceptionMock).toHaveBeenCalledWith(err, { tags: { source: 'profile' } })
    expect(consoleErrorSpy).toHaveBeenCalledWith('[profile]', 'загрузка не удалась', err)
  })

  it('error() без Error в args — обёртывает message в new Error', () => {
    const log = createLogger('checkout')
    log.error('что-то пошло не так', { code: 500 })
    expect(captureExceptionMock).toHaveBeenCalledOnce()
    const [errArg, ctx] = captureExceptionMock.mock.calls[0] as [unknown, { tags: Record<string, string> }]
    expect(errArg).toBeInstanceOf(Error)
    expect((errArg as Error).message).toBe('что-то пошло не так')
    expect(ctx).toEqual({ tags: { source: 'checkout' } })
  })

  it('warn() добавляет breadcrumb (level=warning), без captureException', () => {
    const log = createLogger('search')
    log.warn('rate limited', { retry: 3 })
    expect(addBreadcrumbMock).toHaveBeenCalledWith({
      category: 'search',
      message: 'rate limited',
      level: 'warning',
      data: { args: [{ retry: 3 }] },
    })
    expect(captureExceptionMock).not.toHaveBeenCalled()
    expect(consoleWarnSpy).toHaveBeenCalledWith('[search]', 'rate limited', { retry: 3 })
  })

  it("cache: createLogger('foo') возвращает один и тот же инстанс", () => {
    const a = createLogger('foo')
    const b = createLogger('foo')
    expect(a).toBe(b)
  })
})
