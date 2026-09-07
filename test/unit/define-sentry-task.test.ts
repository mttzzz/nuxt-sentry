import { describe, expect, it, vi } from 'vitest'

vi.mock('nitropack/runtime', () => ({ defineTask: vi.fn((t: unknown) => t) }))
vi.mock('@sentry/bun', () => ({}))

const { runSentryTaskBody } = await import('../../src/runtime/utils/define-sentry-task')

function makeSentryRuntime() {
  return {
    startNewTrace: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    startSpan: vi.fn(async (_opts: { op: string; name: string }, fn: () => Promise<unknown>) => fn()),
    withMonitor: vi.fn(async (_slug: string, fn: () => Promise<unknown>) => fn()),
  }
}

function makeLogger() {
  return { error: vi.fn() }
}

describe('runSentryTaskBody', () => {
  it('success path: возвращает { result: success, ...data }', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    const result = await runSentryTaskBody({
      meta: { name: 'amo-sync' },
      run: () => Promise.resolve({ synced: 5 }),
      logger,
      sentry,
    })
    expect(result).toEqual({ result: 'success', synced: 5 })
    expect(logger.error).not.toHaveBeenCalled()
    expect(sentry.startSpan).toHaveBeenCalledOnce()
    const startSpanCall = sentry.startSpan.mock.calls[0] as [{ op: string; name: string }, unknown]
    expect(startSpanCall[0]).toMatchObject({ op: 'task', name: 'amo-sync' })
  })

  it('error path: возвращает { result: error, message }, логирует, не пробрасывает', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    const result = await runSentryTaskBody({
      meta: { name: 'amo-sync' },
      run: () => Promise.reject(new Error('upstream 500')),
      logger,
      sentry,
    })
    expect(result).toEqual({ result: 'error', message: 'upstream 500' })
    expect(logger.error).toHaveBeenCalledWith('Task amo-sync failed', expect.any(Error))
  })

  it('error path: non-Error throw', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    const result = await runSentryTaskBody({
      meta: { name: 't' },
      // oxlint-disable-next-line prefer-promise-reject-errors -- намеренно тестируем non-Error rejection path
      run: () => Promise.reject('string-thrown'),
      logger,
      sentry,
    })
    expect(result).toEqual({ result: 'error', message: 'string-thrown' })
  })

  it('cron-режим: оборачивается в withMonitor с правильной schedule', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    await runSentryTaskBody({
      meta: { name: 'sync', cron: '*/5 * * * *' },
      run: () => Promise.resolve({}),
      logger,
      sentry,
    })
    expect(sentry.withMonitor).toHaveBeenCalledOnce()
    const withMonitorCall = sentry.withMonitor.mock.calls[0] as unknown as [
      string,
      unknown,
      { schedule: { type: string; value: string }; checkinMargin: number; maxRuntime: number; timezone: string },
    ]
    expect(withMonitorCall[0]).toBe('sync')
    expect(withMonitorCall[2]).toEqual({
      schedule: { type: 'crontab', value: '*/5 * * * *' },
      checkinMargin: 2,
      maxRuntime: 10,
      timezone: 'Etc/UTC',
    })
    expect(sentry.startNewTrace).toHaveBeenCalledOnce()
  })

  it('без cron: только startNewTrace, без withMonitor', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    await runSentryTaskBody({
      meta: { name: 'manual' },
      run: () => Promise.resolve({}),
      logger,
      sentry,
    })
    expect(sentry.withMonitor).not.toHaveBeenCalled()
    expect(sentry.startNewTrace).toHaveBeenCalledOnce()
  })
})
