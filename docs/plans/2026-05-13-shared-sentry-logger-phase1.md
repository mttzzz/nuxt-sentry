# Shared Sentry/Logger Module — Phase 1: pkg release v0.3.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Расширить `@mttzzz/nuxt-sentry` до v0.3.0: добавить sub-path exports `/logger`, `/logger/client`, `/cron`, `/queue`, `/task`, расширить `captureNitroError` опциями `errorReportFilter` + `errorReportEnricher`, auto-import logger/cron/task на server, выложить `dist/`. Цель — закрыть копипасту `logger/sentry-cron/sentry-queue/define-sentry-task` в трёх Nuxt-проектах.

**Architecture:** Каждый submodule живёт отдельным файлом в `src/runtime/utils/` для tree-shake-friendly sub-path exports. `bull` — opt-in peer (`peerDependenciesMeta.bull.optional=true`), kp без него работает. Filter/enricher для error-pipeline передаются как **module paths** (path-based) — module emit'ит virtual templates, которые либо re-export user's default, либо no-op. Тесты — vitest с DI sink'ами / mocked `@sentry/bun` (стиль уже задан в `test/unit/capture-nitro-error.test.ts`).

**Tech Stack:** Nuxt 4.4 module API (`@nuxt/kit`: `addServerImports` / `addTemplate` / `defineNuxtModule`), `@sentry/bun` (peer), `bull` (optional peer), `vitest` (test), `nuxt-module-build` (build).

**Spec:** `docs/specs/2026-05-13-shared-sentry-logger-design.md`

**Working dir for all tasks:** `~/projects/nuxt-sentry/`

**Commit helper:** `bash ~/.claude/scripts/commit-files.sh "<msg>" <files...>` (см. global `explicit-file-commits` skill — параллельные сессии в одной репе требуют explicit file lists).

---

## File Structure (создаётся / меняется в Phase 1)

**Создать:**

- `src/runtime/utils/logger.ts` — server logger + DI sink (canonical из ai)
- `src/runtime/utils/client-logger.ts` — client logger (явный captureException)
- `src/runtime/utils/sentry-cron.ts` — `withCronMonitor`
- `src/runtime/utils/sentry-queue.ts` — Bull producer/consumer
- `src/runtime/utils/define-sentry-task.ts` — `defineSentryTask` + pure `runSentryTaskBody`
- `src/runtime/utils/sentry-report.ts` — `buildSentryReport` (internal helper)
- `test/unit/logger.test.ts`
- `test/unit/client-logger.test.ts`
- `test/unit/sentry-cron.test.ts`
- `test/unit/sentry-queue.test.ts`
- `test/unit/define-sentry-task.test.ts`
- `test/unit/sentry-report.test.ts`

**Модифицировать:**

- `src/runtime/utils/capture-nitro-error.ts` — добавить filter + enricher hooks, использовать `buildSentryReport`
- `src/runtime/types.ts` — добавить `errorReportFilter` / `errorReportEnricher` в `ModuleOptions`
- `src/runtime/server/plugin-capture-errors.ts` — импортить filter/enricher из virtuals
- `src/module.ts` — `addServerImports`, emit virtual templates для filter/enricher, register aliases
- `test/unit/capture-nitro-error.test.ts` — расширить тестами filter + enricher
- `package.json` — exports map, `peerDependenciesMeta.bull.optional`, `version: 0.3.0`
- `README.md` — документация новых exports

**Build artifact:**

- `dist/` — пересобрать через `nuxt-module-build build` и закоммитить (как сейчас принято — github:-deps грузят tarball с dist).

---

## Task 1: Server logger (`createLogger` + `createLoggerWithSink`)

**Files:**

- Create: `src/runtime/utils/logger.ts`
- Create: `test/unit/logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/logger.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createLoggerWithSink, type LoggerSink } from '../../src/runtime/utils/logger'

function makeSink(overrides: Partial<LoggerSink> = {}): LoggerSink {
  return {
    isProduction: false,
    output: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    ...overrides,
  }
}

describe('createLoggerWithSink', () => {
  describe('debug', () => {
    it('пишет в output в dev', () => {
      const sink = makeSink({ isProduction: false })
      const log = createLoggerWithSink('test', sink)
      log.debug('hello', 1, 2)
      expect(sink.output).toHaveBeenCalledWith('debug', 'test', 'hello', [1, 2])
    })

    it('НЕ пишет в production (noise reduction)', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('test', sink)
      log.debug('hello')
      expect(sink.output).not.toHaveBeenCalled()
    })
  })

  describe('info', () => {
    it('пишет в output всегда', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('test', sink)
      log.info('hello', { foo: 1 })
      expect(sink.output).toHaveBeenCalledWith('info', 'test', 'hello', [{ foo: 1 }])
    })

    it('добавляет breadcrumb (level=info) в production', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('amo', sink)
      log.info('synced', { count: 5 })
      expect(sink.addBreadcrumb).toHaveBeenCalledWith({
        category: 'amo',
        message: 'synced',
        level: 'info',
        data: { args: [{ count: 5 }] },
      })
    })

    it('НЕ добавляет breadcrumb в dev', () => {
      const sink = makeSink({ isProduction: false })
      const log = createLoggerWithSink('amo', sink)
      log.info('synced')
      expect(sink.addBreadcrumb).not.toHaveBeenCalled()
    })
  })

  describe('warn', () => {
    it('пишет в output + breadcrumb (level=warning) в production', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('redis', sink)
      log.warn('connection refused')
      expect(sink.output).toHaveBeenCalledWith('warn', 'redis', 'connection refused', [])
      expect(sink.addBreadcrumb).toHaveBeenCalledWith({
        category: 'redis',
        message: 'connection refused',
        level: 'warning',
        data: undefined,
      })
    })
  })

  describe('error', () => {
    it('captureException когда есть Error в args (с тегом source)', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('worker', sink)
      const err = new Error('boom')
      log.error('processing failed', err)
      expect(sink.captureException).toHaveBeenCalledWith(err, {
        tags: { source: 'worker' },
        extra: { message: 'processing failed', args: [err] },
      })
      expect(sink.captureMessage).not.toHaveBeenCalled()
    })

    it('captureMessage (level=error) когда нет Error в args', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('worker', sink)
      log.error('something bad', { foo: 1 })
      expect(sink.captureMessage).toHaveBeenCalledWith('something bad', {
        level: 'error',
        tags: { source: 'worker' },
        extra: { args: [{ foo: 1 }] },
      })
      expect(sink.captureException).not.toHaveBeenCalled()
    })

    it('пишет в output всегда', () => {
      const sink = makeSink({ isProduction: false })
      const log = createLoggerWithSink('worker', sink)
      log.error('msg')
      expect(sink.output).toHaveBeenCalledWith('error', 'worker', 'msg', [])
    })

    it('НЕ шлёт в Sentry в dev', () => {
      const sink = makeSink({ isProduction: false })
      const log = createLoggerWithSink('worker', sink)
      log.error('msg', new Error('x'))
      expect(sink.captureException).not.toHaveBeenCalled()
      expect(sink.captureMessage).not.toHaveBeenCalled()
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/logger.test.ts
```

Expected: `FAIL` — `Cannot find module '../../src/runtime/utils/logger'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/utils/logger.ts
import * as Sentry from '@sentry/bun'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

export interface SentryBreadcrumb {
  category: string
  message: string
  level: 'info' | 'warning'
  data?: Record<string, unknown>
}

export interface LoggerSink {
  isProduction: boolean
  output: (level: LogLevel, tag: string, message: string, args: unknown[]) => void
  captureException: (error: unknown, ctx: { tags: Record<string, string>; extra: Record<string, unknown> }) => void
  captureMessage: (
    message: string,
    ctx: { level: 'error'; tags: Record<string, string>; extra: Record<string, unknown> },
  ) => void
  addBreadcrumb: (breadcrumb: SentryBreadcrumb) => void
}

/*
 * Уровни (best-practice Sentry):
 *   debug → console-only, off в production (noise reduction)
 *   info  → console + Sentry breadcrumb (informational notice, не issue)
 *   warn  → console + Sentry breadcrumb (level=warning — контекст для error)
 *   error → console + captureException (Error в args) или captureMessage
 *
 * Breadcrumb попадает в Sentry только если в том же scope сработает error.
 */
export function createLoggerWithSink(tag: string, sink: LoggerSink): Logger {
  return {
    debug(message, ...args) {
      if (sink.isProduction) return
      sink.output('debug', tag, message, args)
    },
    info(message, ...args) {
      sink.output('info', tag, message, args)
      if (sink.isProduction) {
        sink.addBreadcrumb({ category: tag, message, level: 'info', data: args.length > 0 ? { args } : undefined })
      }
    },
    warn(message, ...args) {
      sink.output('warn', tag, message, args)
      if (sink.isProduction) {
        sink.addBreadcrumb({ category: tag, message, level: 'warning', data: args.length > 0 ? { args } : undefined })
      }
    },
    error(message, ...args) {
      sink.output('error', tag, message, args)
      if (!sink.isProduction) return
      const firstError = args.find((a): a is Error => a instanceof Error)
      const tags = { source: tag }
      if (firstError) {
        sink.captureException(firstError, { tags, extra: { message, args } })
      } else {
        sink.captureMessage(message, { level: 'error', tags, extra: { args } })
      }
    },
  }
}

const defaultSink: LoggerSink = {
  isProduction: process.env.NODE_ENV === 'production',
  output(level, tag, message, args) {
    /* eslint-disable no-console -- logger is the only place that should use console */
    if (level === 'error') {
      console.error(`[${tag}]`, message, ...args)
    } else if (level === 'warn') {
      console.warn(`[${tag}]`, message, ...args)
    } else if (level === 'info') {
      console.info(`[${tag}]`, message, ...args)
    } else {
      console.debug(`[${tag}]`, message, ...args)
    }
    /* eslint-enable no-console */
  },
  captureException(error, ctx) {
    Sentry.captureException(error, ctx)
  },
  captureMessage(message, ctx) {
    Sentry.captureMessage(message, ctx)
  },
  addBreadcrumb(breadcrumb) {
    Sentry.addBreadcrumb(breadcrumb)
  },
}

const loggerCache = new Map<string, Logger>()

export function createLogger(tag: string): Logger {
  const cached = loggerCache.get(tag)
  if (cached) return cached
  const logger = createLoggerWithSink(tag, defaultSink)
  loggerCache.set(tag, logger)
  return logger
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/logger.test.ts
```

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(logger): server logger с DI sink (4 уровня + breadcrumbs + captureMessage fallback)" src/runtime/utils/logger.ts test/unit/logger.test.ts
```

---

## Task 2: Client logger

**Files:**

- Create: `src/runtime/utils/client-logger.ts`
- Create: `test/unit/client-logger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/client-logger.test.ts
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
    const [errArg, ctx] = captureExceptionMock.mock.calls[0]
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/client-logger.test.ts
```

Expected: `FAIL` — `Cannot find module '../../src/runtime/utils/client-logger'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/utils/client-logger.ts
import * as Sentry from '@sentry/vue'

export interface ClientLogger {
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

const loggerCache = new Map<string, ClientLogger>()

export function createLogger(tag: string): ClientLogger {
  const cached = loggerCache.get(tag)
  if (cached) return cached

  const logger: ClientLogger = {
    warn(message, ...args) {
      // eslint-disable-next-line no-console -- logger is the only place that should use console
      console.warn(`[${tag}]`, message, ...args)
      Sentry.addBreadcrumb({
        category: tag,
        message,
        level: 'warning',
        data: args.length > 0 ? { args } : undefined,
      })
    },
    error(message, ...args) {
      // eslint-disable-next-line no-console -- logger is the only place that should use console
      console.error(`[${tag}]`, message, ...args)
      const firstError = args.find((a): a is Error => a instanceof Error)
      const err = firstError ?? new Error(message)
      Sentry.captureException(err, { tags: { source: tag } })
    },
  }

  loggerCache.set(tag, logger)
  return logger
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/client-logger.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(client-logger): явный captureException + breadcrumb-on-warn (без consola)" src/runtime/utils/client-logger.ts test/unit/client-logger.test.ts
```

---

## Task 3: `withCronMonitor`

**Files:**

- Create: `src/runtime/utils/sentry-cron.ts`
- Create: `test/unit/sentry-cron.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/sentry-cron.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const withMonitorMock = vi.fn(async (_slug: string, fn: () => Promise<unknown>, _config: unknown) => fn())

vi.mock('@sentry/bun', () => ({
  withMonitor: withMonitorMock,
}))

const { withCronMonitor } = await import('../../src/runtime/utils/sentry-cron')

describe('withCronMonitor', () => {
  beforeEach(() => {
    withMonitorMock.mockClear()
  })

  it('вызывает Sentry.withMonitor с slug, schedule (crontab) и дефолтами', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withCronMonitor('amo-sync', '*/5 * * * *', fn)

    expect(result).toBe('ok')
    expect(withMonitorMock).toHaveBeenCalledOnce()
    const [slug, , config] = withMonitorMock.mock.calls[0]
    expect(slug).toBe('amo-sync')
    expect(config).toEqual({
      schedule: { type: 'crontab', value: '*/5 * * * *' },
      checkinMargin: 2,
      maxRuntime: 10,
      timezone: 'Etc/UTC',
    })
  })

  it('overrides: checkinMargin/maxRuntime', async () => {
    await withCronMonitor('long-task', '0 * * * *', async () => {}, { checkinMargin: 5, maxRuntime: 30 })
    const [, , config] = withMonitorMock.mock.calls[0]
    expect(config).toMatchObject({ checkinMargin: 5, maxRuntime: 30 })
  })

  it('пробрасывает ошибку из fn (не глотает)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('task failed'))
    await expect(withCronMonitor('x', '* * * * *', fn)).rejects.toThrow('task failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/sentry-cron.test.ts
```

Expected: `FAIL` — `Cannot find module '../../src/runtime/utils/sentry-cron'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/utils/sentry-cron.ts
import * as Sentry from '@sentry/bun'

export interface CronMonitorOptions {
  checkinMargin?: number
  maxRuntime?: number
  timezone?: string
}

/*
 * Оборачивает Nitro scheduled task в Sentry Crons monitor.
 * Автоматически отправляет check-in (in_progress → ok/error).
 * Monitor создаётся в Sentry автоматически при первом вызове.
 */
export async function withCronMonitor<T>(
  slug: string,
  schedule: string,
  fn: () => Promise<T>,
  options?: CronMonitorOptions,
): Promise<T> {
  return Sentry.withMonitor(slug, fn, {
    schedule: { type: 'crontab', value: schedule },
    checkinMargin: options?.checkinMargin ?? 2,
    maxRuntime: options?.maxRuntime ?? 10,
    timezone: options?.timezone ?? 'Etc/UTC',
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/sentry-cron.test.ts
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(cron): withCronMonitor — Sentry Crons check-in для Nitro tasks" src/runtime/utils/sentry-cron.ts test/unit/sentry-cron.test.ts
```

---

## Task 4: Bull queue instrumentation (`instrumentQueueProducer` + `withSentryConsumer`)

**Files:**

- Create: `src/runtime/utils/sentry-queue.ts`
- Create: `test/unit/sentry-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/sentry-queue.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const startNewTraceMock = vi.fn(async (fn: () => Promise<unknown>) => fn())
const startSpanMock = vi.fn(async (_opts: unknown, fn: (span: { setStatus: () => void }) => Promise<unknown>) =>
  fn({ setStatus: vi.fn() }),
)
const continueTraceMock = vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn())
const captureExceptionMock = vi.fn()
const getTraceDataMock = vi.fn(() => ({ 'sentry-trace': 'abc-123', baggage: 'sentry-x=y' }))

vi.mock('@sentry/bun', () => ({
  startNewTrace: startNewTraceMock,
  startSpan: startSpanMock,
  continueTrace: continueTraceMock,
  captureException: captureExceptionMock,
  getTraceData: getTraceDataMock,
}))

const { instrumentQueueProducer, withSentryConsumer } = await import('../../src/runtime/utils/sentry-queue')

interface FakeQueue {
  name: string
  add: (...args: unknown[]) => Promise<unknown>
}

function makeFakeQueue(): FakeQueue & { _addCalls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    name: 'media',
    _addCalls: calls,
    add(...args: unknown[]) {
      calls.push(args)
      return Promise.resolve({ id: '42' })
    },
  }
}

describe('instrumentQueueProducer', () => {
  beforeEach(() => {
    startNewTraceMock.mockClear()
    startSpanMock.mockClear()
    getTraceDataMock.mockClear()
  })

  it('инжектит trace headers в job-data при default-style add(data, opts)', async () => {
    const queue = makeFakeQueue()
    instrumentQueueProducer(queue as never)

    await queue.add({ payload: 'x' }, { delay: 100 })

    expect(startNewTraceMock).toHaveBeenCalledOnce()
    const [data, opts] = queue._addCalls[0] as [Record<string, unknown>, unknown]
    expect(data).toMatchObject({
      payload: 'x',
      _sentryTrace: 'abc-123',
      _sentryBaggage: 'sentry-x=y',
    })
    expect(typeof data._sentryPublishedAt).toBe('number')
    expect(opts).toEqual({ delay: 100 })
  })

  it('инжектит trace headers при named-style add(name, data, opts)', async () => {
    const queue = makeFakeQueue()
    instrumentQueueProducer(queue as never)

    await queue.add('process-image', { id: 1 }, { attempts: 3 })

    const [name, data, opts] = queue._addCalls[0] as [string, Record<string, unknown>, unknown]
    expect(name).toBe('process-image')
    expect(data).toMatchObject({ id: 1, _sentryTrace: 'abc-123' })
    expect(opts).toEqual({ attempts: 3 })
  })
})

describe('withSentryConsumer', () => {
  beforeEach(() => {
    startNewTraceMock.mockClear()
    startSpanMock.mockClear()
    continueTraceMock.mockClear()
    captureExceptionMock.mockClear()
  })

  it('continueTrace когда есть _sentryTrace в job-data', async () => {
    const job = {
      id: 'job-1',
      data: { payload: 'x', _sentryTrace: 'abc', _sentryBaggage: 'b', _sentryPublishedAt: Date.now() - 100 },
      attemptsMade: 0,
    }
    const result = await withSentryConsumer('media', job as never, async () => 'done')

    expect(result).toBe('done')
    expect(continueTraceMock).toHaveBeenCalledOnce()
    expect(continueTraceMock.mock.calls[0][0]).toEqual({ sentryTrace: 'abc', baggage: 'b' })
    expect(startNewTraceMock).not.toHaveBeenCalled()
  })

  it('startNewTrace когда _sentryTrace отсутствует', async () => {
    const job = { id: 'j', data: { payload: 'x' }, attemptsMade: 0 }
    await withSentryConsumer('media', job as never, async () => 'ok')
    expect(startNewTraceMock).toHaveBeenCalledOnce()
    expect(continueTraceMock).not.toHaveBeenCalled()
  })

  it('captureException + rethrow при ошибке fn', async () => {
    const job = { id: 'j', data: { payload: 'x' }, attemptsMade: 0 }
    const err = new Error('processing failed')
    await expect(
      withSentryConsumer('media', job as never, async () => {
        throw err
      }),
    ).rejects.toThrow('processing failed')
    expect(captureExceptionMock).toHaveBeenCalledWith(err)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/sentry-queue.test.ts
```

Expected: `FAIL` — `Cannot find module '../../src/runtime/utils/sentry-queue'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/utils/sentry-queue.ts
/*
 * Sentry Queue Monitoring — инструментация Bull queues.
 *
 * Два механизма:
 * 1. instrumentQueueProducer(queue) — monkey-patch .add() для автоматического
 *    создания queue.publish спанов и инъекции trace headers в job data.
 * 2. withSentryConsumer(queueName, job, fn) — обёртка для consumer callback,
 *    создаёт queue.process спан и продолжает trace от producer.
 *
 * @see https://docs.sentry.io/platforms/javascript/guides/node/tracing/instrumentation/custom-instrumentation/queues-module/
 */
import * as Sentry from '@sentry/bun'
import type Queue from 'bull'

interface SentryQueueMeta {
  _sentryTrace?: string
  _sentryBaggage?: string
  _sentryPublishedAt?: number
}

export function instrumentQueueProducer<T>(queue: Queue.Queue<T>): Queue.Queue<T> {
  const originalAdd = queue.add.bind(queue) as (
    ...args: [string, unknown, Queue.JobOptions?] | [unknown, Queue.JobOptions?]
  ) => Promise<Queue.Job<T>>

  queue.add = (async (...args: unknown[]) => {
    const isNamed = typeof args[0] === 'string'
    const jobType = isNamed ? (args[0] as string) : 'default'
    const data = (isNamed ? args[1] : args[0]) as Record<string, unknown>
    const opts = (isNamed ? args[2] : args[1]) as Queue.JobOptions | undefined
    const bodySize = JSON.stringify(data).length

    return Sentry.startNewTrace(async () =>
      Sentry.startSpan({ name: `queue.publish/${queue.name}` }, async () =>
        Sentry.startSpan(
          {
            op: 'queue.publish',
            name: queue.name,
            attributes: {
              'messaging.message.id': jobType,
              'messaging.destination.name': queue.name,
              'messaging.message.body.size': bodySize,
            },
          },
          async () => {
            const traceData = Sentry.getTraceData()
            const enrichedData: Record<string, unknown> = {
              ...data,
              _sentryTrace: traceData?.['sentry-trace'],
              _sentryBaggage: traceData?.baggage,
              _sentryPublishedAt: Date.now(),
            }
            return isNamed ? originalAdd(jobType, enrichedData, opts) : originalAdd(enrichedData, opts)
          },
        ),
      ),
    )
  }) as typeof queue.add

  return queue
}

export async function withSentryConsumer<T, R>(queueName: string, job: Queue.Job<T>, fn: () => Promise<R>): Promise<R> {
  const data = job.data as T & SentryQueueMeta
  const { _sentryTrace, _sentryBaggage, _sentryPublishedAt } = data
  const receiveLatency = _sentryPublishedAt ? Date.now() - _sentryPublishedAt : undefined

  async function processJob() {
    return Sentry.startSpan({ name: `queue.process/${queueName}` }, async (parentSpan) =>
      Sentry.startSpan(
        {
          op: 'queue.process',
          name: queueName,
          attributes: {
            'messaging.message.id': String(job.id),
            'messaging.destination.name': queueName,
            'messaging.message.body.size': JSON.stringify(job.data).length,
            'messaging.message.retry.count': job.attemptsMade,
            ...(receiveLatency !== undefined && { 'messaging.message.receive.latency': receiveLatency }),
          },
        },
        async () => {
          try {
            const result = await fn()
            parentSpan.setStatus({ code: 1, message: 'ok' })
            return result
          } catch (error) {
            parentSpan.setStatus({ code: 2, message: 'error' })
            Sentry.captureException(error)
            throw error
          }
        },
      ),
    )
  }

  if (_sentryTrace) {
    return Sentry.continueTrace({ sentryTrace: _sentryTrace, baggage: _sentryBaggage }, processJob)
  }
  return Sentry.startNewTrace(processJob)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/sentry-queue.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(queue): instrumentQueueProducer + withSentryConsumer для Bull (opt-in peer-dep)" src/runtime/utils/sentry-queue.ts test/unit/sentry-queue.test.ts
```

---

## Task 5: `defineSentryTask` (+ pure `runSentryTaskBody`)

**Files:**

- Create: `src/runtime/utils/define-sentry-task.ts`
- Create: `test/unit/define-sentry-task.test.ts`

Note: `defineTask` — Nitro global, доступен в runtime/server context. Юнит-тесты тестируют ТОЛЬКО `runSentryTaskBody` (pure), интеграция `defineTask` проверяется в smoke playground (Task 12).

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/define-sentry-task.test.ts
import { describe, expect, it, vi } from 'vitest'

import { runSentryTaskBody } from '../../src/runtime/utils/define-sentry-task'

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
      run: async () => ({ synced: 5 }),
      logger,
      sentry,
    })
    expect(result).toEqual({ result: 'success', synced: 5 })
    expect(logger.error).not.toHaveBeenCalled()
    expect(sentry.startSpan).toHaveBeenCalledOnce()
    expect(sentry.startSpan.mock.calls[0][0]).toMatchObject({ op: 'task', name: 'amo-sync' })
  })

  it('error path: возвращает { result: error, message }, логирует, не пробрасывает', async () => {
    const sentry = makeSentryRuntime()
    const logger = makeLogger()
    const result = await runSentryTaskBody({
      meta: { name: 'amo-sync' },
      run: async () => {
        throw new Error('upstream 500')
      },
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
      run: async () => {
        throw 'string-thrown'
      },
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
      run: async () => ({}),
      logger,
      sentry,
    })
    expect(sentry.withMonitor).toHaveBeenCalledOnce()
    const [slug, , config] = sentry.withMonitor.mock.calls[0]
    expect(slug).toBe('sync')
    expect(config).toEqual({
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
      run: async () => ({}),
      logger,
      sentry,
    })
    expect(sentry.withMonitor).not.toHaveBeenCalled()
    expect(sentry.startNewTrace).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/define-sentry-task.test.ts
```

Expected: `FAIL` — `Cannot find module '../../src/runtime/utils/define-sentry-task'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/utils/define-sentry-task.ts
import * as Sentry from '@sentry/bun'
import { defineTask } from 'nitropack/runtime'

import { createLogger, type Logger } from './logger'

export interface SentryTaskMeta {
  name: string
  description: string
  /* Cron-расписание для Sentry Crons monitor (auto-alert если task не запустился). */
  cron?: string
}

export interface SentryTaskOutcome {
  result: 'success' | 'error'
  message?: string
  [key: string]: unknown
}

interface SentryRuntime {
  startNewTrace: (fn: () => Promise<unknown>) => Promise<unknown>
  startSpan: (
    opts: { op: string; name: string; attributes?: Record<string, unknown> },
    fn: () => Promise<unknown>,
  ) => Promise<unknown>
  withMonitor: (slug: string, fn: () => Promise<unknown>, monitorConfig: unknown) => Promise<unknown>
}

interface LoggerSurface {
  error: (msg: string, ...args: unknown[]) => void
}

interface RunBodyArgs<R extends Record<string, unknown>> {
  meta: { name: string; cron?: string }
  run: () => Promise<R>
  logger: LoggerSurface
  sentry: SentryRuntime
}

/*
 * Pure execution body — testable без Nitro/Sentry SDK.
 *
 * Sentry-обвязка:
 *   1. startNewTrace — новый trace на каждый запуск
 *   2. startSpan op=task — длительность в Performance
 *   3. withMonitor (если есть cron) — Sentry Crons check-in alert
 *
 * Error path: catch → logger.error (наш sink уходит в Sentry с тегом
 * source=task:<name>) → возвращаем { result: error, message }. Никогда не
 * пробрасываем — Nitro task runner не интегрирован с error-hook'ом.
 */
export async function runSentryTaskBody<R extends Record<string, unknown>>({
  meta,
  run,
  logger,
  sentry,
}: RunBodyArgs<R>): Promise<SentryTaskOutcome> {
  async function body(): Promise<SentryTaskOutcome> {
    return sentry.startSpan({ op: 'task', name: meta.name, attributes: { 'task.name': meta.name } }, async () => {
      try {
        const data = await run()
        return { result: 'success', ...data }
      } catch (error: unknown) {
        logger.error(`Task ${meta.name} failed`, error)
        return {
          result: 'error',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }) as Promise<SentryTaskOutcome>
  }

  if (meta.cron) {
    return sentry.withMonitor(meta.name, () => sentry.startNewTrace(body), {
      schedule: { type: 'crontab', value: meta.cron },
      checkinMargin: 2,
      maxRuntime: 10,
      timezone: 'Etc/UTC',
    }) as Promise<SentryTaskOutcome>
  }
  return sentry.startNewTrace(body) as Promise<SentryTaskOutcome>
}

const defaultSentry: SentryRuntime = {
  startNewTrace: (fn) => Sentry.startNewTrace(fn),
  startSpan: (opts, fn) => Sentry.startSpan(opts as never, fn),
  withMonitor: (slug, fn, config) => Sentry.withMonitor(slug, fn, config as never),
}

/*
 * Обёртка над Nitro defineTask. defineTask импортится явно из 'nitropack/runtime'
 * (тот же путь, что pkg уже использует для defineNitroPlugin в plugin-capture-errors).
 * Logger автоматически создан с тегом `task:<meta.name>` и приходит первым аргументом в run.
 */
export function defineSentryTask<R extends Record<string, unknown>>(opts: {
  meta: SentryTaskMeta
  run: (ctx: { logger: Logger }) => Promise<R>
}) {
  const { name, description, cron } = opts.meta
  const logger = createLogger(`task:${name}`)
  return defineTask({
    meta: { name, description },
    async run() {
      return runSentryTaskBody({
        meta: { name, cron },
        run: () => opts.run({ logger }),
        logger,
        sentry: defaultSentry,
      })
    },
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/define-sentry-task.test.ts
```

Expected: 5 passed. (`defineTask` явно импортится из `nitropack/runtime` — типы доступны в `runtime/utils/` без server-tsconfig. Тесты вызывают только `runSentryTaskBody`, top-level `import { defineTask }` evaluate'ится через `nitropack` dev-dep — должно резолвиться. Если в test runtime есть проблема с side-effect'ами `nitropack/runtime` импорта — добавить в `vi.mock('nitropack/runtime', () => ({ defineTask: (x: unknown) => x }))` в test header.)

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(task): defineSentryTask — обёртка над Nitro defineTask с Sentry Crons + transaction + единый error path" src/runtime/utils/define-sentry-task.ts test/unit/define-sentry-task.test.ts
```

---

## Task 6: `buildSentryReport` (internal helper)

**Files:**

- Create: `src/runtime/utils/sentry-report.ts`
- Create: `test/unit/sentry-report.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/sentry-report.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/sentry-report.test.ts
```

Expected: `FAIL` — `Cannot find module '../../src/runtime/utils/sentry-report'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runtime/utils/sentry-report.ts
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
  if (typeof cause.name === 'string') summary.name = cause.name
  if (typeof cause.message === 'string') summary.message = cause.message
  if (isRecord(cause.$metadata) && typeof cause.$metadata.httpStatusCode === 'number') {
    summary.httpStatusCode = cause.$metadata.httpStatusCode
  }
  if (typeof cause.stack === 'string') summary.stack = cause.stack
  return summary
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/sentry-report.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(sentry-report): buildSentryReport — internal helper для capture-nitro-error (cause + appData + h3 headers)" src/runtime/utils/sentry-report.ts test/unit/sentry-report.test.ts
```

---

## Task 7: Расширение `captureNitroError` (filter + enricher hooks + buildSentryReport)

**Files:**

- Modify: `src/runtime/utils/capture-nitro-error.ts`
- Modify: `test/unit/capture-nitro-error.test.ts`

- [ ] **Step 1: Дополнить failing tests**

Открыть `test/unit/capture-nitro-error.test.ts` и добавить блок ПОСЛЕ существующего `describe('captureNitroError', ...)`:

```ts
describe('captureNitroError — filter + enricher', () => {
  beforeEach(() => {
    captureExceptionMock.mockClear()
    setExtrasMock.mockClear()
    withScopeMock.mockClear()
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
    const extras = setExtrasMock.mock.calls[0][0] as Record<string, unknown>
    expect(extras).toMatchObject({
      url: '/api/x',
      method: 'POST',
      appData: { code: 'E_X' },
      custom: 'value',
    })
    expect(extras.cause).toMatchObject({ name: 'AWSError', message: 'denied' })

    expect(captureExceptionMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        mechanism: { handled: false, type: 'nitro' },
      }),
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
```

- [ ] **Step 2: Run test to verify failures**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/capture-nitro-error.test.ts
```

Expected: 4 новых FAIL ("captureNitroError: too few arguments" / extras не содержит appData / etc).

- [ ] **Step 3: Modify implementation**

Заменить содержимое `src/runtime/utils/capture-nitro-error.ts` на:

```ts
import * as Sentry from '@sentry/bun'

import { buildSentryReport } from './sentry-report'

/*
 * Pure handler для nitro error-hook — форвардит ошибку в Sentry.
 *
 * @sentry/bun ловит только process-level uncaught exceptions, а nitro перехватывает
 * ошибки хендлеров внутри request-pipeline и сам конвертит в 500 + лог
 * `[request error] [unhandled]`. Без явного хука 5xx из server/api/* в Sentry не доходят.
 *
 * Default-фильтрация: 4xx (createError H3Error 401/403/404/422) — ожидаемые
 * user-facing ошибки, в Sentry не шлём, иначе шум.
 *
 * Расширения через options:
 *   - filter(error)  → return false → событие пропускается (после 4xx-skip).
 *     Use case: ai's "Cannot find static asset" skip.
 *   - enricher(error, event) → { extra?, tags? } merge'ится поверх default
 *     buildSentryReport (url/method/headers/cause/appData).
 *     Use case: project-specific дополнительный контекст.
 */

interface NitroErrorContext {
  event?: {
    path?: string
    method?: string
    node?: { req?: { url?: string; method?: string; headers?: Record<string, string> } }
  }
}

export interface CaptureNitroErrorOptions {
  filter?: (error: unknown) => boolean
  enricher?: (error: unknown, event?: unknown) => { extra?: Record<string, unknown>; tags?: Record<string, string> }
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number') return value
  }
  return undefined
}

export function captureNitroError(
  error: unknown,
  context: NitroErrorContext,
  options?: CaptureNitroErrorOptions,
): void {
  const statusCode = getStatusCode(error)
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return
  }

  if (options?.filter && !options.filter(error)) {
    return
  }

  const errorLike = (typeof error === 'object' && error !== null ? error : {}) as Parameters<
    typeof buildSentryReport
  >[0]
  const baseReport = buildSentryReport(errorLike, context.event as never)
  const enrichment = options?.enricher?.(error, context.event) ?? {}
  const extras = { ...baseReport.extra, ...enrichment.extra }
  const tags = { ...baseReport.tags, ...enrichment.tags }

  Sentry.withScope((scope) => {
    scope.setExtras(extras)
    if (Object.keys(tags).length > 0) {
      scope.setTags(tags)
    }
    Sentry.captureException(error, {
      mechanism: { handled: false, type: 'nitro' },
    })
  })
}
```

Note: новый API добавляет `setTags` через `withScope` — нужно обновить мок `withScope` в test header. Открыть `test/unit/capture-nitro-error.test.ts` и обновить mock:

```ts
const setTagsMock = vi.fn()
const withScopeMock = vi.fn((cb: (scope: { setExtras: typeof setExtrasMock; setTags: typeof setTagsMock }) => void) => {
  cb({ setExtras: setExtrasMock, setTags: setTagsMock })
})
```

И в `beforeEach` добавить `setTagsMock.mockClear()`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/projects/nuxt-sentry && bun vitest run test/unit/capture-nitro-error.test.ts
```

Expected: все тесты passed (старые 4 + новые 4).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(capture-nitro-error): filter + enricher options + integrate buildSentryReport (extras: cause + appData)" src/runtime/utils/capture-nitro-error.ts test/unit/capture-nitro-error.test.ts
```

---

## Task 8: ModuleOptions types + plugin-capture-errors интеграция

**Files:**

- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/server/plugin-capture-errors.ts`

- [ ] **Step 1: Read current types**

```bash
cd ~/projects/nuxt-sentry && cat src/runtime/types.ts
```

Заметить, где определены `ModuleOptions` и `ResolvedModuleOptions`.

- [ ] **Step 2: Modify `src/runtime/types.ts`**

Добавить в `ModuleOptions` (и в `ResolvedModuleOptions` соответственно):

```ts
/*
 * Path к модулю с default export-функцией:
 *   filter(error) → boolean — return false → событие НЕ шлётся в Sentry.
 *
 * Use case: project-specific skip-патерны ("Cannot find static asset", etc).
 * Если не задано — все non-4xx ошибки идут в Sentry (default-фильтрация 4xx работает всегда).
 *
 * Пример: errorReportFilter: '~/server/utils/error-filter'
 */
errorReportFilter?: string

/*
 * Path к модулю с default export-функцией:
 *   enricher(error, event) → { extra?, tags? } — merge'ится поверх default
 *   buildSentryReport (url/method/headers/cause/appData).
 *
 * Use case: project-specific дополнительный контекст для Sentry-issue.
 * Пример: errorReportEnricher: '~/server/utils/error-enricher'
 */
errorReportEnricher?: string
```

- [ ] **Step 3: Modify `src/runtime/server/plugin-capture-errors.ts`**

Заменить содержимое на:

```ts
import { defineNitroPlugin } from 'nitropack/runtime'

import { captureNitroError } from '../utils/capture-nitro-error'

/* Virtual modules — emit'ятся module.ts. Если соответствующая опция не задана,
   pkg экспортит no-op (filter → () => true, enricher → () => ({})). */
// @ts-expect-error virtual module resolved at build time via nitro alias
import errorReportFilter from '#nuxt-sentry/error-filter'
// @ts-expect-error virtual module resolved at build time via nitro alias
import errorReportEnricher from '#nuxt-sentry/error-enricher'

/*
 * Форвардит unhandled-ошибки nitro request-pipeline в Sentry. Без этого хука
 * `@sentry/bun` ловит только process-level uncaught exceptions, а 500-ки
 * из server/api/* молча падают в `[request error] [unhandled]`-лог.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error, ctx) => {
    captureNitroError(error, ctx, { filter: errorReportFilter, enricher: errorReportEnricher })
  })
})
```

- [ ] **Step 4: Verify typecheck**

```bash
cd ~/projects/nuxt-sentry && bun run lint && bun vitest run
```

Expected: lint clean, все unit-тесты passed (плагин не тестим напрямую — это интеграция через playground).

- [ ] **Step 5: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(types,plugin-capture-errors): wire errorReportFilter/Enricher через virtual modules" src/runtime/types.ts src/runtime/server/plugin-capture-errors.ts
```

---

## Task 9: `module.ts` — addServerImports + emit virtual templates

**Files:**

- Modify: `src/module.ts`

- [ ] **Step 1: Найти место для inserts**

Открыть `src/module.ts`. Найти:

- Существующий блок `addServerImports({ name: 'instrumentPostgresJs', ... })` (строки ~71-74) — вставить наши auto-imports рядом.
- Существующий `addTemplate({ filename: 'nuxt-sentry-build-config.mjs', ... })` (строки ~139-154) — взять за образец для новых virtuals.
- Существующие `nuxt.options.alias` / `nuxt.options.nitro.alias` присваивания — добавить два новых alias'а.

- [ ] **Step 2: Расширить `addServerImports` блок**

Заменить существующий single-import блок на массив:

```ts
addServerImports([
  {
    name: 'instrumentPostgresJs',
    from: resolver.resolve('./runtime/utils/instrument-postgres-js'),
  },
  {
    name: 'createLogger',
    from: resolver.resolve('./runtime/utils/logger'),
  },
  {
    name: 'createLoggerWithSink',
    from: resolver.resolve('./runtime/utils/logger'),
  },
  {
    name: 'withCronMonitor',
    from: resolver.resolve('./runtime/utils/sentry-cron'),
  },
  {
    name: 'defineSentryTask',
    from: resolver.resolve('./runtime/utils/define-sentry-task'),
  },
])
```

- [ ] **Step 3: Emit virtual templates для filter/enricher**

После существующего `buildConfigTpl = addTemplate({...})` добавить:

```ts
/*
 * Virtual modules для error-pipeline customization. Если опция не задана —
 * экспортим no-op default. Если задана — re-export user's default.
 *
 * Path-based вместо inline functions: function-literal сериализация в build-config
 * хрупка (closures, scope), path-based — детерминирован.
 */
function buildVirtualReexport(userPath: string | undefined, fallback: string): string {
  if (userPath) {
    /* Nuxt-style ~/... → должно резолвиться aliasами consumer'а. Передаём как есть. */
    return `export { default } from ${JSON.stringify(userPath)}\n`
  }
  return `export default ${fallback}\n`
}

const errorFilterTpl = addTemplate({
  filename: 'nuxt-sentry-error-filter.mjs',
  write: true,
  getContents: () => buildVirtualReexport(opts.errorReportFilter, '() => true'),
})

const errorEnricherTpl = addTemplate({
  filename: 'nuxt-sentry-error-enricher.mjs',
  write: true,
  getContents: () => buildVirtualReexport(opts.errorReportEnricher, '() => ({})'),
})
```

- [ ] **Step 4: Зарегистрировать aliases для virtuals**

Сразу после существующих:

```ts
nuxt.options.alias['#nuxt-sentry/config'] = buildConfigTpl.dst
```

Добавить:

```ts
nuxt.options.alias['#nuxt-sentry/error-filter'] = errorFilterTpl.dst
nuxt.options.alias['#nuxt-sentry/error-enricher'] = errorEnricherTpl.dst
```

И аналогично для nitro.alias (после существующего `nuxt.options.nitro.alias['#nuxt-sentry/config']`):

```ts
nuxt.options.nitro.alias['#nuxt-sentry/error-filter'] = errorFilterTpl.dst
nuxt.options.nitro.alias['#nuxt-sentry/error-enricher'] = errorEnricherTpl.dst
```

- [ ] **Step 5: Lint + module-build**

```bash
cd ~/projects/nuxt-sentry && bun run lint && bun run dev:prepare
```

Expected: lint clean; `nuxt-module-build prepare` без ошибок (auto-import типы должны попасть в `.nuxt/types`).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(module): addServerImports для logger/cron/task + virtual templates для error filter/enricher" src/module.ts
```

---

## Task 10: `package.json` — exports map + peer deps + version bump

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Read current package.json**

```bash
cd ~/projects/nuxt-sentry && cat package.json
```

- [ ] **Step 2: Edit `package.json`**

Сделать три изменения через Edit:

**a) `version`:**

```diff
-  "version": "0.2.0",
+  "version": "0.3.0",
```

**b) `exports` map** — добавить sub-paths:

```diff
   "exports": {
     ".": {
       "types": "./dist/types.d.mts",
       "import": "./dist/module.mjs"
     },
     "./utils": {
       "types": "./dist/runtime/utils/instrument-postgres-js.d.ts",
       "import": "./dist/runtime/utils/instrument-postgres-js.js"
+    },
+    "./logger": {
+      "types": "./dist/runtime/utils/logger.d.ts",
+      "import": "./dist/runtime/utils/logger.js"
+    },
+    "./logger/client": {
+      "types": "./dist/runtime/utils/client-logger.d.ts",
+      "import": "./dist/runtime/utils/client-logger.js"
+    },
+    "./cron": {
+      "types": "./dist/runtime/utils/sentry-cron.d.ts",
+      "import": "./dist/runtime/utils/sentry-cron.js"
+    },
+    "./queue": {
+      "types": "./dist/runtime/utils/sentry-queue.d.ts",
+      "import": "./dist/runtime/utils/sentry-queue.js"
+    },
+    "./task": {
+      "types": "./dist/runtime/utils/define-sentry-task.d.ts",
+      "import": "./dist/runtime/utils/define-sentry-task.js"
     }
   },
```

**c) `peerDependencies` + `peerDependenciesMeta`:**

```diff
   "peerDependencies": {
     "@sentry/bun": "^10.52.0",
     "@sentry/core": "^10.52.0",
     "@sentry/vite-plugin": "^5.0.0",
     "@sentry/vue": "^10.52.0",
-    "nuxt": "^4.4.5"
+    "nuxt": "^4.4.5",
+    "bull": "^4.0.0"
+  },
+  "peerDependenciesMeta": {
+    "bull": {
+      "optional": true
+    }
   }
```

**d) `devDependencies`** — добавить `bull` для тестов:

```diff
   "devDependencies": {
     ...
+    "bull": "^4.16.5",
     ...
   }
```

(Бамп фактической версии при `bun install` — bun сам подберёт совместимый.)

- [ ] **Step 3: Install + run all tests**

```bash
cd ~/projects/nuxt-sentry && bun install && bun vitest run
```

Expected: все unit-тесты (старые + новые из task 1-7) passed.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "feat(pkg)!: v0.3.0 exports map (logger/cron/queue/task) + opt-in bull peer-dep" package.json bun.lock
```

---

## Task 11: README documentation

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Read current README**

```bash
cd ~/projects/nuxt-sentry && cat README.md
```

- [ ] **Step 2: Append "v0.3.0 utilities" section**

Добавить новую секцию (точное место — после раздела про module setup, до раздела changelog/license, если такие есть):

````markdown
## Server-side utilities (auto-imported)

После регистрации модуля в server-runtime'е consumer'а доступны следующие auto-imports — без явного `import`:

### `createLogger(tag) → Logger`

```ts
const log = createLogger('amo-sync')
log.debug('low-level diag', { count }) // off в production
log.info('synced ok', { count }) // + Sentry breadcrumb (info)
log.warn('rate limit hit', { retry: 3 }) // + Sentry breadcrumb (warning)
log.error('upstream failed', err) // → Sentry captureException (Error в args) или captureMessage
```

Семантика по уровням и breadcrumb-механика — в `src/runtime/utils/logger.ts`.

### `defineSentryTask({ meta, run })`

```ts
export default defineSentryTask({
  meta: { name: 'amo-sync', description: 'Sync Amo entities', cron: '*/5 * * * *' },
  async run({ logger }) {
    logger.info('sync start')
    return { synced: 5 }
  },
})
```

Получает `logger` с тегом `task:<name>`, оборачивает в `Sentry.startNewTrace + startSpan(op:'task') + withMonitor` (если есть `cron`). Catch внутри — error не пробрасывается, возвращается `{ result: 'error', message }`.

### `withCronMonitor(slug, schedule, fn, opts?)`

Низкоуровневый wrapper для случаев вне Nitro task'а. `defineSentryTask` использует его внутри.

### `instrumentPostgresJs(sql)`

(существует с v0.2) — оборачивает postgres-js клиент для Sentry DB spans на Bun.

## Sub-path exports (явный import)

```ts
// Bull queue tracing (opt-in: peer-dep bull)
import { instrumentQueueProducer, withSentryConsumer } from '@mttzzz/nuxt-sentry/queue'

// Client logger (app/, не auto-import)
import { createLogger } from '@mttzzz/nuxt-sentry/logger/client'
```

## Error pipeline customization

В `nuxt.config.ts`:

```ts
sentry: {
  dsn: '...',
  project: '...',
  cachePrefix: '...',

  // Path к модулю с default export — функция (error) → boolean
  // false → событие НЕ шлётся в Sentry (после default 4xx-skip)
  errorReportFilter: '~/server/utils/error-filter',

  // Path к модулю с default export — функция (error, event) → { extra?, tags? }
  // Merge'ится поверх default extras (url/method/headers/cause/appData)
  errorReportEnricher: '~/server/utils/error-enricher',
}
```

Default report: `url`, `method`, `headers` (JSON-serialized), `error.cause` (с AWS-style $metadata), `error.data` (h3 createError data → `appData`). Tag: `source: nitro-error-hook`.
````

- [ ] **Step 3: Commit**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "docs(README): v0.3.0 utilities + sub-path exports + error-pipeline customization" README.md
```

---

## Task 12: Build dist + playground smoke + final commit

**Files:**

- Build: `dist/**` (overwrite)
- Optional: `playground/server/api/_smoke.get.ts`

- [ ] **Step 1: Add playground smoke endpoint**

Создать `playground/server/api/_smoke.get.ts`:

```ts
/* Smoke: использует все auto-imported helpers — проверяет, что nuxi prepare
   корректно генерирует типы и runtime подцепляет наши auto-imports. */
export default defineEventHandler(() => {
  const log = createLogger('smoke')
  log.info('smoke endpoint hit')
  return { ok: true }
})
```

(Не пишем тестов под smoke — это integration, проверяется через `nuxt prepare` ниже.)

- [ ] **Step 2: Run prepare to verify auto-imports compile**

```bash
cd ~/projects/nuxt-sentry && bun run dev:prepare
```

Expected: без ошибок. `playground/.nuxt/types/nitro-imports.d.ts` содержит `createLogger`, `createLoggerWithSink`, `withCronMonitor`, `defineSentryTask`, `instrumentPostgresJs`. Можно проверить grep'ом:

```bash
cd ~/projects/nuxt-sentry && grep -E "createLogger|withCronMonitor|defineSentryTask" playground/.nuxt/types/nitro-imports.d.ts
```

Expected: 4-5 строк matched.

- [ ] **Step 3: Build dist**

```bash
cd ~/projects/nuxt-sentry && bun run prepack
```

Expected: `dist/` пересобран. `nuxt-module-build build` создаёт `dist/module.mjs`, `dist/runtime/utils/*.{mjs,d.ts}`.

Verify:

```bash
cd ~/projects/nuxt-sentry && ls dist/runtime/utils/
```

Expected: содержит `logger.{js,d.ts}`, `client-logger.{js,d.ts}`, `sentry-cron.{js,d.ts}`, `sentry-queue.{js,d.ts}`, `define-sentry-task.{js,d.ts}`, `sentry-report.{js,d.ts}`, `capture-nitro-error.{js,d.ts}`, `instrument-postgres-js.{js,d.ts}`, остальные existing.

- [ ] **Step 4: Final test run**

```bash
cd ~/projects/nuxt-sentry && bun vitest run
```

Expected: все тесты passed (logger × 9, client-logger × 4, sentry-cron × 3, sentry-queue × 5, define-sentry-task × 5, sentry-report × 7, capture-nitro-error × 8 = 41+ existing).

- [ ] **Step 5: Lint final**

```bash
cd ~/projects/nuxt-sentry && bun run lint
```

Expected: clean (или только варнинги, не errors).

- [ ] **Step 6: Commit dist + smoke**

```bash
cd ~/projects/nuxt-sentry && bash ~/.claude/scripts/commit-files.sh "build(dist): rebuild для v0.3.0 — sub-path exports + auto-imports + error-pipeline hooks" dist playground/server/api/_smoke.get.ts
```

(Если `playground/.nuxt/` попал в diff — он gitignored, не должен. Если попал — добавить в `.gitignore`.)

- [ ] **Step 7: Tag the release**

```bash
cd ~/projects/nuxt-sentry && git tag -a v0.3.0 -m "v0.3.0 — shared logger + cron + queue + task + error-pipeline customization"
```

(Push отдельно по запросу пользователя — НЕ автоматически. Согласно global git-дисциплине: разрешение на коммит ≠ разрешение на push.)

---

## End-of-phase checklist (manual)

- [ ] Все 12 tasks завершены, каждый с зелёным test'ом и commit'ом
- [ ] `bun vitest run` — все passed
- [ ] `bun run lint` — clean
- [ ] `bun run dev:prepare` — playground prepare без ошибок, типы auto-imports на месте
- [ ] `dist/` закоммичен, версия v0.3.0
- [ ] Tag `v0.3.0` создан локально
- [ ] **НЕ** запушено — ждём явного "push" от пользователя
- [ ] **НЕ** начата Phase 2 (easy2 migration) — это отдельный план в отдельной сессии

После approval push'а пользователем — Phase 2/3/4 (миграция easy2/kp/ai) идут отдельными планами в репах consumer-проектов, каждая со своим spec/plan циклом. Они НЕ часть этого плана.
