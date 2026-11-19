import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const taskLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    taskLogger,
    defineTask: vi.fn((task: unknown) => task),
    startNewTrace: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    startSpan: vi.fn(async (_options: unknown, fn: () => Promise<unknown>) => fn()),
    withMonitor: vi.fn(async (_slug: string, fn: () => Promise<unknown>, _config: unknown) => fn()),
    createLogger: vi.fn((_tag: string) => taskLogger),
  }
})

/* Модуль nitropack/runtime тянет #nitro-internal-virtual/storage — только в nitro-бандле. */
vi.mock('nitropack/runtime', () => ({ defineTask: mocks.defineTask }))
vi.mock('@sentry/bun', () => ({
  startNewTrace: mocks.startNewTrace,
  startSpan: mocks.startSpan,
  withMonitor: mocks.withMonitor,
}))
vi.mock('../../src/runtime/utils/logger', () => ({ createLogger: mocks.createLogger }))

const { defineSentryTask, runSentryTaskBody } = await import('../../src/runtime/utils/define-sentry-task')

function makeSentryRuntime() {
  return {
    startNewTrace: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    startSpan: vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn()),
    withMonitor: vi.fn(async (_slug: string, fn: () => Promise<unknown>, _cfg: unknown) => fn()),
  }
}

function makeLogger() {
  return { error: vi.fn<(msg: string, ...args: unknown[]) => void>() }
}

const TASK_META = { name: 'test:demo' }

describe('runSentryTaskBody', () => {
  it('success → { result: "success", ...data }, один новый trace и один span op=task', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    const run = vi.fn(() => Promise.resolve({ enriched: 5, skipped: 0 }))

    const out = await runSentryTaskBody({ meta: TASK_META, run, logger, sentry })

    expect(out).toEqual({ result: 'success', enriched: 5, skipped: 0 })
    expect(sentry.startNewTrace).toHaveBeenCalledTimes(1)
    expect(sentry.startSpan).toHaveBeenCalledTimes(1)
    expect(sentry.startSpan.mock.calls[0]?.[0]).toMatchObject({
      op: 'task',
      name: 'test:demo',
      attributes: { 'task.name': 'test:demo' },
    })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('throws Error → ровно один logger.error с тем же объектом ошибки + { result: "error", message }', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    const err = new Error('boom')
    const run = vi.fn(() => Promise.reject(err))

    const out = await runSentryTaskBody({ meta: TASK_META, run, logger, sentry })

    expect(out).toEqual({ result: 'error', message: 'boom' })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toBe('Task test:demo failed')
    expect(logger.error.mock.calls[0]?.[1]).toBe(err)
  })

  it('throws non-Error → message = String(value), один logger.error со значением как есть', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    // oxlint-disable-next-line prefer-promise-reject-errors -- Намеренно тестируем non-Error rejection path
    const run = vi.fn(() => Promise.reject('string-error'))

    const out = await runSentryTaskBody({ meta: TASK_META, run, logger, sentry })

    expect(out).toEqual({ result: 'error', message: 'string-error' })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.slice(0, 2)).toEqual(['Task test:demo failed', 'string-error'])
  })

  it('с meta.cron → withMonitor с полным расписанием, внутри него один новый trace и один span', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    const run = vi.fn(() => Promise.resolve({}))

    await runSentryTaskBody({ meta: { name: 'test:cron', cron: '0 6 * * *' }, run, logger, sentry })

    expect(sentry.withMonitor).toHaveBeenCalledTimes(1)
    expect(sentry.withMonitor.mock.calls[0]?.[0]).toBe('test:cron')
    expect(sentry.withMonitor.mock.calls[0]?.[2]).toEqual({
      schedule: { type: 'crontab', value: '0 6 * * *' },
      checkinMargin: 2,
      maxRuntime: 10,
      timezone: 'Etc/UTC',
    })
    expect(sentry.startNewTrace).toHaveBeenCalledTimes(1)
    expect(sentry.startSpan).toHaveBeenCalledTimes(1)
  })

  it('без meta.cron → withMonitor не вызывается, trace один', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    const run = vi.fn(() => Promise.resolve({}))

    await runSentryTaskBody({ meta: TASK_META, run, logger, sentry })

    expect(sentry.withMonitor).not.toHaveBeenCalled()
    expect(sentry.startNewTrace).toHaveBeenCalledTimes(1)
  })
})

interface NitroTask {
  meta: Record<string, unknown>
  run: () => Promise<unknown>
}

function register(options: Parameters<typeof defineSentryTask>[0]): NitroTask {
  defineSentryTask(options)
  return mocks.defineTask.mock.calls.at(-1)?.[0] as NitroTask
}

describe('defineSentryTask: обвязка над Nitro defineTask и Sentry SDK', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Nitro получает только name и description (cron живёт в Sentry), logger — с тегом task:<name>', async () => {
    const run = vi.fn((_context: { logger: unknown }) => Promise.resolve({ done: 1 }))

    const task = register({ meta: { name: 'amo-sync', description: 'Sync', cron: '*/5 * * * *' }, run })

    expect(task.meta).toEqual({ name: 'amo-sync', description: 'Sync' })
    expect(mocks.createLogger).toHaveBeenCalledWith('task:amo-sync')
    expect(await task.run()).toEqual({ result: 'success', done: 1 })
    expect(run).toHaveBeenCalledWith({ logger: mocks.taskLogger })
  })

  it('на настоящем Sentry API: span op=task в новом trace, withMonitor — только с cron', async () => {
    const cron = register({
      meta: { name: 'with-cron', description: 'd', cron: '*/5 * * * *' },
      run: () => Promise.resolve({}),
    })
    await cron.run()
    expect(mocks.withMonitor).toHaveBeenCalledTimes(1)
    expect(mocks.withMonitor.mock.calls[0]?.[0]).toBe('with-cron')
    expect(mocks.withMonitor.mock.calls[0]?.[2]).toMatchObject({ schedule: { type: 'crontab', value: '*/5 * * * *' } })
    expect(mocks.startNewTrace).toHaveBeenCalledTimes(1)
    expect(mocks.startSpan.mock.calls[0]?.[0]).toMatchObject({ op: 'task', name: 'with-cron' })

    vi.clearAllMocks()
    const plain = register({ meta: { name: 'plain', description: 'd' }, run: () => Promise.resolve({}) })
    await plain.run()
    expect(mocks.withMonitor).not.toHaveBeenCalled()
    expect(mocks.startNewTrace).toHaveBeenCalledTimes(1)
  })

  it('сбой run не пробрасывается в Nitro: { result: "error", message } и logger.error', async () => {
    const err = new Error('upstream 500')
    const task = register({ meta: { name: 'fails', description: 'd' }, run: () => Promise.reject(err) })

    await expect(task.run()).resolves.toEqual({ result: 'error', message: 'upstream 500' })
    expect(mocks.taskLogger.error).toHaveBeenCalledTimes(1)
    expect(mocks.taskLogger.error).toHaveBeenCalledWith('Task fails failed', err)
  })
})
