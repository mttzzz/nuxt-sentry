import { beforeEach, describe, expect, it, vi } from 'vitest'

const setTagMock = vi.fn()
const setExtrasMock = vi.fn()
const withScopeMock = vi.fn((run: (scope: { setTag: typeof setTagMock; setExtras: typeof setExtrasMock }) => void) => {
  run({ setTag: setTagMock, setExtras: setExtrasMock })
})
const captureExceptionMock = vi.fn()
const addBreadcrumbMock = vi.fn()

vi.mock('@sentry/vue', () => ({
  withScope: withScopeMock,
  captureException: captureExceptionMock,
  addBreadcrumb: addBreadcrumbMock,
}))

const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

const { createLogger } = await import('../../src/runtime/utils/client-logger')

describe('client createLogger (issues-first)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('error: console.error внутри withScope(source), без explicit captureException', () => {
    const err = new Error('boom')
    createLogger('profile').error('загрузка не удалась', err)
    expect(withScopeMock).toHaveBeenCalled()
    expect(setTagMock).toHaveBeenCalledWith('source', 'profile')
    expect(consoleErrorSpy).toHaveBeenCalledWith('[profile]', 'загрузка не удалась', err)
    /* Анти-дубль: Issue заводит captureConsoleIntegration, logger явно не капчит. */
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('warn: console.warn внутри withScope(source)', () => {
    createLogger('search').warn('rate limited', { retry: 3 })
    expect(setTagMock).toHaveBeenCalledWith('source', 'search')
    expect(consoleWarnSpy).toHaveBeenCalledWith('[search]', 'rate limited', { retry: 3 })
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it("cache: createLogger('foo') возвращает один и тот же инстанс", () => {
    expect(createLogger('foo')).toBe(createLogger('foo'))
  })
})
