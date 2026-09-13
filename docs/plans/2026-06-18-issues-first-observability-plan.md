# Issues-first Observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести `@mttzzz/nuxt-sentry` на issues-first observability: любой `console.warn/error` → Sentry Issue с полным контекстом (replay/stacktrace/breadcrumbs/`source`-тег), Sentry Logs выключены, сторонний/extension-шум отсекается фильтром по стеку. Валидировать на kp.modmb.com.

**Architecture:** `captureConsoleIntegration({levels:['warn','error']})` на client+server заменяет `consoleLoggingIntegration` (`enableLogs:false`). `createLogger` пишет в console внутри `Sentry.withScope` (обогащает event `source`-тегом+extra; capture неявный через captureConsole — один канал, ноль дублей). Новый предикат `isNoiseEvent(event)` дропает extension/anonymous-recursion шум в `beforeSend`.

**Tech Stack:** Nuxt 4 module, `@sentry/vue` (client), `@sentry/bun` (server), `@sentry/core` (captureConsoleIntegration), vitest, oxlint/oxfmt, `nuxt-module-build`.

**Спека:** `docs/specs/2026-06-18-issues-first-observability-design.md`
**Smoke (выполнен в дизайне):** `withScope` прокидывает `source`-тег на captureConsole-event; Error в args → реальный stacktrace. Подтверждено.

---

## Pre-flight

- **Работаем в репо модуля** `~/projects/nuxt-sentry` (Phase 1, Tasks 1–7), затем в `~/projects/kp.modmb.com` (Phase 2, Task 8).
- Команды модуля: тесты `bun run test` (vitest), lint `bun run lint`, fmt `bun run fmt`, build `bun run prepack` (= `nuxt-module-build build`).
- **dist коммитится** (github-dep): после изменений src — обязательно `bun run prepack` и коммит `dist/` вместе с `src/` (см. memory `project_mttzzz_github_deps_rebuild_dist`).
- Коммиты — conventional, по одному логическому изменению. Push — только по явному разрешению пользователя.
- Сначала каждый коммит зелёный по `bun run test`; build+version — отдельным финальным коммитом Phase 1.

## File Structure (Phase 1, module)

- `src/runtime/utils/before-send.ts` — **Create:** `isNoiseEvent(event): boolean` (предикат extension/anonymous-recursion шума).
- `test/unit/before-send.test.ts` — **Create:** тесты предиката.
- `src/runtime/utils/logger.ts` — **Modify:** reshape sink (withSourceScope вместо captureException/captureMessage).
- `test/unit/logger.test.ts` — **Modify:** под новый sink.
- `src/runtime/utils/client-logger.ts` — **Modify:** withScope+console, без explicit capture/breadcrumb.
- `src/runtime/plugin.client.ts` — **Modify:** captureConsole, enableLogs:false, beforeSend+noise, replay-on-error default.
- `src/runtime/instrument.server.ts` — **Modify:** captureConsole, enableLogs:false, beforeSend+noise, ignoreErrors.
- `package.json` — **Modify:** version 0.6.0 → 0.7.0.
- `dist/**` — **Rebuild** через prepack.

---

### Task 1: `isNoiseEvent` — фильтр extension/recursion-шума

**Files:**

- Create: `src/runtime/utils/before-send.ts`
- Create: `test/unit/before-send.test.ts`

- [ ] **Step 1: Failing test с реальным extension-payload (KP-MODMB-COM-M)**

`test/unit/before-send.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { isNoiseEvent } from '../../src/runtime/utils/before-send'

/* Реальная сигнатура из KP-MODMB-COM-M: браузерное расширение рекурсивно патчит
 * Object.getOwnPropertyDescriptor → стек из одних анонимных _getOwnPropertyDescriptor. */
function extensionFrames(n: number) {
  return Array.from({ length: n }, () => ({
    function: 'Object.getOwnPropertyDescriptor [as _getOwnPropertyDescriptor]',
    filename: '<anonymous>',
    lineno: 1,
    colno: 3085,
  }))
}

describe('isNoiseEvent', () => {
  it('дропает extension-рекурсию (все фреймы <anonymous>)', () => {
    const event = { exception: { values: [{ type: 'RangeError', stacktrace: { frames: extensionFrames(48) } }] } }
    expect(isNoiseEvent(event)).toBe(true)
  })

  it('дропает стек из chrome-extension:// фреймов', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            stacktrace: {
              frames: [
                { function: 'x', filename: 'chrome-extension://abc/content.js', lineno: 1, colno: 2 },
                { function: 'y', filename: 'chrome-extension://abc/content.js', lineno: 3, colno: 4 },
              ],
            },
          },
        ],
      },
    }
    expect(isNoiseEvent(event)).toBe(true)
  })

  it('пропускает настоящую ошибку приложения (реальные filename)', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'TypeError',
            stacktrace: {
              frames: [
                { function: 'loadMore', filename: 'app://app/composables/useInfiniteTable.ts', lineno: 200, colno: 5 },
                { function: 'fetchPage', filename: 'app://app/composables/useInfiniteTable.ts', lineno: 188, colno: 7 },
              ],
            },
          },
        ],
      },
    }
    expect(isNoiseEvent(event)).toBe(false)
  })

  it('пропускает event без стека (не трогаем)', () => {
    expect(isNoiseEvent({ message: 'plain log' })).toBe(false)
    expect(isNoiseEvent({ exception: { values: [{ type: 'Error', stacktrace: { frames: [] } }] } })).toBe(false)
  })
})
```

- [ ] **Step 2: Run — FAIL (модуля нет)**

Run: `bun run test before-send`
Expected: FAIL — `Cannot find module '../../src/runtime/utils/before-send'`.

- [ ] **Step 3: Реализация**

`src/runtime/utils/before-send.ts`:

```ts
import type { ErrorEvent, Event } from '@sentry/core'

const EXTENSION_PROTOCOL = /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//u

/* Считаем фрейм «не-нашим»: анонимный (<anonymous>/пусто) или из браузерного расширения. */
function isNoiseFrame(filename: string | undefined): boolean {
  const f = filename ?? ''
  return f === '' || f === '<anonymous>' || EXTENSION_PROTOCOL.test(f)
}

/*
 * Под catch-all (captureConsoleIntegration) message-based ignoreErrors НЕ ловит шум
 * с нормальным сообщением, но мусорным стеком (extension рекурсивно патчит глобал →
 * RangeError со стеком из одних анонимных фреймов; пример — issue KP-MODMB-COM-M).
 * Дропаем event, если ВЕСЬ стек — не-наши фреймы. Event без exception/стека не трогаем.
 */
export function isNoiseEvent(event: Event): boolean {
  const frames = (event as ErrorEvent).exception?.values?.flatMap((v) => v.stacktrace?.frames ?? []) ?? []
  if (frames.length === 0) {
    return false
  }
  return frames.every((frame) => isNoiseFrame(frame.filename))
}
```

- [ ] **Step 4: Run — PASS**

Run: `bun run test before-send`
Expected: PASS (4 теста).

- [ ] **Step 5: fmt + commit**

```bash
bun run fmt src/runtime/utils/before-send.ts test/unit/before-send.test.ts
git add -- src/runtime/utils/before-send.ts test/unit/before-send.test.ts
git commit -m "feat(before-send): isNoiseEvent — дроп extension/anonymous-recursion шума"
```

---

### Task 2: Reshape server `logger.ts` (sink под captureConsole)

**Files:**

- Modify: `src/runtime/utils/logger.ts`
- Modify: `test/unit/logger.test.ts`

- [ ] **Step 1: Обновить тест под новый sink (warn/error → withSourceScope+output, без captureException)**

Заменить `test/unit/logger.test.ts` целиком:

```ts
import { describe, expect, it, vi } from 'vitest'

import { createLogger, createLoggerWithSink, type LoggerSink } from '../../src/runtime/utils/logger'

function makeSink(overrides: Partial<LoggerSink> = {}): LoggerSink {
  return {
    isProduction: false,
    output: vi.fn<LoggerSink['output']>(),
    /* withSourceScope сразу вызывает write() — так тест видит и факт обогащения, и output */
    withSourceScope: vi.fn<LoggerSink['withSourceScope']>((_tag, _extra, write) => {
      write()
    }),
    addBreadcrumb: vi.fn<LoggerSink['addBreadcrumb']>(),
    ...overrides,
  }
}

describe('createLoggerWithSink', () => {
  describe('debug', () => {
    it('output в dev, тишина в prod', () => {
      const dev = makeSink({ isProduction: false })
      createLoggerWithSink('t', dev).debug('hi', 1)
      expect(dev.output).toHaveBeenCalledWith('debug', 't', 'hi', [1])

      const prod = makeSink({ isProduction: true })
      createLoggerWithSink('t', prod).debug('hi')
      expect(prod.output).not.toHaveBeenCalled()
    })
  })

  describe('info', () => {
    it('output всегда + breadcrumb(level=info) в prod, без withSourceScope', () => {
      const sink = makeSink({ isProduction: true })
      createLoggerWithSink('amo', sink).info('synced', { count: 5 })
      expect(sink.output).toHaveBeenCalledWith('info', 'amo', 'synced', [{ count: 5 }])
      expect(sink.addBreadcrumb).toHaveBeenCalledWith({
        category: 'amo',
        message: 'synced',
        level: 'info',
        data: { args: [{ count: 5 }] },
      })
      expect(sink.withSourceScope).not.toHaveBeenCalled()
    })
  })

  describe('warn', () => {
    it('prod: output обёрнут в withSourceScope(source, extra) — даёт Issue через captureConsole', () => {
      const sink = makeSink({ isProduction: true })
      createLoggerWithSink('redis', sink).warn('connection refused', { attempt: 2 })
      expect(sink.withSourceScope).toHaveBeenCalledWith(
        'redis',
        { message: 'connection refused', args: [{ attempt: 2 }] },
        expect.any(Function),
      )
      expect(sink.output).toHaveBeenCalledWith('warn', 'redis', 'connection refused', [{ attempt: 2 }])
    })

    it('dev: только output, без withSourceScope', () => {
      const sink = makeSink({ isProduction: false })
      createLoggerWithSink('redis', sink).warn('x')
      expect(sink.output).toHaveBeenCalledWith('warn', 'redis', 'x', [])
      expect(sink.withSourceScope).not.toHaveBeenCalled()
    })
  })

  describe('error', () => {
    it('prod: output обёрнут в withSourceScope(source, extra)', () => {
      const sink = makeSink({ isProduction: true })
      const err = new Error('boom')
      createLoggerWithSink('worker', sink).error('failed', err)
      expect(sink.withSourceScope).toHaveBeenCalledWith(
        'worker',
        { message: 'failed', args: [err] },
        expect.any(Function),
      )
      expect(sink.output).toHaveBeenCalledWith('error', 'worker', 'failed', [err])
    })

    it('dev: только output, без withSourceScope', () => {
      const sink = makeSink({ isProduction: false })
      createLoggerWithSink('worker', sink).error('msg', new Error('x'))
      expect(sink.output).toHaveBeenCalledWith('error', 'worker', 'msg', [new Error('x')])
      expect(sink.withSourceScope).not.toHaveBeenCalled()
    })
  })
})

describe('createLogger cache', () => {
  it('один инстанс на тег', () => {
    expect(createLogger('cache-test')).toBe(createLogger('cache-test'))
  })
})
```

- [ ] **Step 2: Run — FAIL (старый sink)**

Run: `bun run test logger`
Expected: FAIL — `withSourceScope` не существует в sink / старая семантика error.

- [ ] **Step 3: Реализация — reshape logger.ts**

Заменить `src/runtime/utils/logger.ts`:

```ts
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
  /* warn/error в prod: обогащает Sentry-scope (source-тег + extra) на время write().
   * captureConsoleIntegration ловит console.* внутри этого scope → Issue с контекстом. */
  withSourceScope: (tag: string, extra: Record<string, unknown>, write: () => void) => void
  addBreadcrumb: (breadcrumb: SentryBreadcrumb) => void
}

/*
 * Issues-first (см. docs/specs/2026-06-18-issues-first-observability-design.md):
 *   debug → console-only, off в prod
 *   info  → console + breadcrumb(level=info) — контекст, НЕ Issue
 *   warn  → console.warn внутри withSourceScope → Issue(level=warning) через captureConsole
 *   error → console.error внутри withSourceScope → Issue(level=error) через captureConsole
 * Capture неявный (captureConsoleIntegration) — logger НЕ зовёт captureException (анти-дубль).
 */
export function createLoggerWithSink(tag: string, sink: LoggerSink): Logger {
  return {
    debug(message, ...args) {
      if (sink.isProduction) {
        return
      }
      sink.output('debug', tag, message, args)
    },
    info(message, ...args) {
      sink.output('info', tag, message, args)
      if (sink.isProduction) {
        sink.addBreadcrumb({ category: tag, message, level: 'info', data: args.length > 0 ? { args } : undefined })
      }
    },
    warn(message, ...args) {
      if (sink.isProduction) {
        sink.withSourceScope(tag, { message, args }, () => sink.output('warn', tag, message, args))
      } else {
        sink.output('warn', tag, message, args)
      }
    },
    error(message, ...args) {
      if (sink.isProduction) {
        sink.withSourceScope(tag, { message, args }, () => sink.output('error', tag, message, args))
      } else {
        sink.output('error', tag, message, args)
      }
    },
  }
}

const defaultSink: LoggerSink = {
  isProduction: process.env.NODE_ENV === 'production',
  output(level, tag, message, args) {
    /* oxlint-disable no-console -- logger is the only place that should use console */
    const dispatch = { error: console.error, warn: console.warn, info: console.info, debug: console.debug } as const
    /* oxlint-enable no-console */
    dispatch[level](`[${tag}]`, message, ...args)
  },
  withSourceScope(tag, extra, write) {
    Sentry.withScope((scope) => {
      scope.setTag('source', tag)
      scope.setExtras(extra)
      write()
    })
  },
  addBreadcrumb(breadcrumb) {
    Sentry.addBreadcrumb(breadcrumb)
  },
}

const loggerCache = new Map<string, Logger>()

export function createLogger(tag: string): Logger {
  const cached = loggerCache.get(tag)
  if (cached) {
    return cached
  }
  const logger = createLoggerWithSink(tag, defaultSink)
  loggerCache.set(tag, logger)
  return logger
}
```

- [ ] **Step 4: Run — PASS**

Run: `bun run test logger`
Expected: PASS.

- [ ] **Step 5: fmt + commit**

```bash
bun run fmt src/runtime/utils/logger.ts test/unit/logger.test.ts
git add -- src/runtime/utils/logger.ts test/unit/logger.test.ts
git commit -m "refactor(logger): issues-first — withSourceScope + console, без explicit capture (captureConsole — единый канал)"
```

---

### Task 3: Reshape `client-logger.ts`

**Files:**

- Modify: `src/runtime/utils/client-logger.ts`
- Test: `test/unit/client-logger.test.ts` (создать, если отсутствует — см. Step 1)

- [ ] **Step 1: Тест клиентского логгера**

Создать/заменить `test/unit/client-logger.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

const withScope = vi.fn((cb: (s: { setTag: typeof setTag; setExtras: typeof setExtras }) => void) =>
  cb({ setTag, setExtras }),
)
const setTag = vi.fn()
const setExtras = vi.fn()
const captureException = vi.fn()

vi.mock('@sentry/vue', () => ({ withScope, captureException, addBreadcrumb: vi.fn() }))

describe('client createLogger (issues-first)', () => {
  it('error: console.error внутри withScope(source), без explicit captureException', async () => {
    const { createLogger } = await import('../../src/runtime/utils/client-logger')
    createLogger('ui').error('boom', new Error('x'))
    expect(withScope).toHaveBeenCalled()
    expect(setTag).toHaveBeenCalledWith('source', 'ui')
    expect(captureException).not.toHaveBeenCalled() // анти-дубль: ловит captureConsole
  })

  it('warn: console.warn внутри withScope(source)', async () => {
    const { createLogger } = await import('../../src/runtime/utils/client-logger')
    createLogger('ui2').warn('careful')
    expect(setTag).toHaveBeenCalledWith('source', 'ui2')
  })
})
```

- [ ] **Step 2: Run — FAIL**

Run: `bun run test client-logger`
Expected: FAIL — текущий client-logger зовёт `captureException` явно.

- [ ] **Step 3: Реализация**

Заменить `src/runtime/utils/client-logger.ts`:

```ts
import * as Sentry from '@sentry/vue'

export interface ClientLogger {
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

const loggerCache = new Map<string, ClientLogger>()

/*
 * Issues-first: warn/error пишутся в console внутри Sentry.withScope (source-тег + extra);
 * Issue заводит captureConsoleIntegration (см. plugin.client.ts) — единый канал, без дублей.
 */
export function createLogger(tag: string): ClientLogger {
  const cached = loggerCache.get(tag)
  if (cached) {
    return cached
  }

  function emit(level: 'warn' | 'error', message: string, args: unknown[]): void {
    Sentry.withScope((scope) => {
      scope.setTag('source', tag)
      scope.setExtras({ message, args })
      /* oxlint-disable no-console -- logger is the only place that should use console */
      if (level === 'error') {
        console.error(`[${tag}]`, message, ...args)
      } else {
        console.warn(`[${tag}]`, message, ...args)
      }
      /* oxlint-enable no-console */
    })
  }

  const logger: ClientLogger = {
    warn(message, ...args) {
      emit('warn', message, args)
    },
    error(message, ...args) {
      emit('error', message, args)
    },
  }

  loggerCache.set(tag, logger)
  return logger
}
```

- [ ] **Step 4: Run — PASS**

Run: `bun run test client-logger`
Expected: PASS.

- [ ] **Step 5: fmt + commit**

```bash
bun run fmt src/runtime/utils/client-logger.ts test/unit/client-logger.test.ts
git add -- src/runtime/utils/client-logger.ts test/unit/client-logger.test.ts
git commit -m "refactor(client-logger): issues-first — withScope + console, без explicit captureException"
```

---

### Task 4: `plugin.client.ts` — captureConsole, Logs off, noise-filter

**Files:**

- Modify: `src/runtime/plugin.client.ts`

- [ ] **Step 1: Применить изменения**

В `src/runtime/plugin.client.ts`:

(a) добавить импорт предиката рядом с другими util-импортами:

```ts
import { isNoiseEvent } from './utils/before-send'
```

(b) `enableLogs: true` → `enableLogs: false`.

(c) Заменить `beforeSend`-строку. Было:

```ts
    beforeSend: createSentryStaleChunkFilter(),
```

Стало (noise-фильтр первым, потом stale-chunk):

```ts
    beforeSend: (event, hint) => (isNoiseEvent(event) ? null : staleChunkFilter(event, hint)),
```

и выше, перед `Sentry.init`, вынести фильтр в const:

```ts
const staleChunkFilter = createSentryStaleChunkFilter()
```

(d) Удалить весь блок опции `beforeSendLog: (log) => {...}` (Logs выключены — больше не нужен). Заодно удалить ставший неиспользуемым импорт `isIgnoredSentryMessage` (если он использовался только в beforeSendLog).

(e) В массиве `integrations` заменить:

```ts
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error', 'info'] }),
```

на:

```ts
      Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] }),
```

(f) Replay-on-error по умолчанию 1.0 (каждый Issue с видео). Заменить:

```ts
    replaysOnErrorSampleRate: config.replaysOnErrorSampleRate,
```

на:

```ts
    replaysOnErrorSampleRate: config.replaysOnErrorSampleRate ?? 1.0,
```

- [ ] **Step 2: Lint (runtime-файл, type-aware)**

Run: `bun run lint src/runtime/plugin.client.ts`
Expected: 0 ошибок. Если `isIgnoredSentryMessage`/`buildIgnoreErrors` стали неиспользуемы — убрать импорты (оставить `buildIgnoreErrors`, он всё ещё нужен для `ignoreErrors`).

- [ ] **Step 3: Commit**

```bash
bun run fmt src/runtime/plugin.client.ts
git add -- src/runtime/plugin.client.ts
git commit -m "feat(client): captureConsole catch-all + enableLogs:false + noise-filter beforeSend + replay-on-error 1.0"
```

---

### Task 5: `instrument.server.ts` — captureConsole, Logs off, noise-filter, ignoreErrors

**Files:**

- Modify: `src/runtime/instrument.server.ts`

- [ ] **Step 1: Применить изменения**

В `src/runtime/instrument.server.ts`:

(a) импорты сверху:

```ts
import { isNoiseEvent } from './utils/before-send'
import { buildIgnoreErrors } from './utils/ignore-errors'
```

(b) `enableLogs: true` → `enableLogs: false`.

(c) в `integrations` добавить (после redisIntegration):

```ts
    Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] }),
```

(d) добавить в объект `Sentry.init({...})` (рядом с `sendDefaultPii`):

```ts
  ignoreErrors: buildIgnoreErrors(),
  beforeSend: (event) => (isNoiseEvent(event) ? null : event),
```

- [ ] **Step 2: Lint + типы**

Run: `bun run lint src/runtime/instrument.server.ts`
Expected: 0 ошибок. (`buildIgnoreErrors` импортирует STALE_CHUNK_PATTERNS из stale-deploy-guard — на сервере это безвредный набор regex; если возникнет проблема резолва на сервере — выделить серверный subset в plan-уточнении, но дефолт: общий список.)

- [ ] **Step 3: Commit**

```bash
bun run fmt src/runtime/instrument.server.ts
git add -- src/runtime/instrument.server.ts
git commit -m "feat(server): captureConsole + enableLogs:false + noise-filter + ignoreErrors"
```

---

### Task 6: Полный прогон тестов модуля

- [ ] **Step 1: Все unit-тесты зелёные**

Run: `bun run test`
Expected: PASS (before-send + logger + client-logger + существующие ignore-errors/tunnel/instrument-postgres).

- [ ] **Step 2: Типы (если test:types быстрый)**

Run: `bun run test:types`
Expected: без ошибок (vue-tsc). Если долго/флейки — пропустить, положиться на consumer-typecheck в Task 8.

---

### Task 7: Build dist + version bump 0.7.0 + commit

**Files:**

- Modify: `package.json` (version)
- Rebuild: `dist/**`

- [ ] **Step 1: Bump версии**

В `package.json`: `"version": "0.6.0"` → `"version": "0.7.0"`.

- [ ] **Step 2: Build dist**

Run: `bun run prepack`
Expected: пересборка `dist/` без ошибок.

- [ ] **Step 3: Commit src-already-committed + dist + version**

```bash
git add -- package.json dist
git commit -m "build: dist + bump 0.7.0 (issues-first observability)"
```

_(src уже закоммичен по задачам; здесь — только package.json + dist.)_

---

## Phase 2 — Валидация на kp.modmb.com

### Task 8: kp — bump, очистка, проверка

**Files (в `~/projects/kp.modmb.com`):**

- Modify: `package.json` / `bun.lock` (bump dep)
- Modify: `nuxt.config.ts` (убрать `/_getOwnPropertyDescriptor/`)

- [ ] **Step 1: Bump зависимости**

```bash
cd ~/projects/kp.modmb.com
bun update @mttzzz/nuxt-sentry
```

Проверить, что `node_modules/@mttzzz/nuxt-sentry/package.json` version = 0.7.0.

- [ ] **Step 2: Убрать утренний log-only хак**

В `nuxt.config.ts` удалить из `sentry.additionalIgnorePatterns` блок-коммент + строку `/_getOwnPropertyDescriptor/` (extension-шум теперь ловит noise-stack-filter на уровне Issue). View-transition/manifest/network паттерны оставить.

- [ ] **Step 3: Source maps включены? (для «полный контекст»)**

Проверить: `@sentry/vite-plugin` сконфигурён с release + authToken (иначе стек в Issue минифицирован).
Run: `grep -nE 'sentryVitePlugin|sourcemap|authToken|SENTRY_AUTH' nuxt.config.ts`
Если не настроено — отметить пользователю (отдельная задача), не блокировать.

- [ ] **Step 4: Пайплайн + полный suite**

Run: `bun fmt nuxt.config.ts` затем `bun typecheck`, затем `bun test:unit && bun test:component && bun test:integration && bun test:e2e`.
Expected: всё зелёное (host-stack для integration/e2e — поднять `bun preview:test`, как в oxlint-миграции). redis NOAUTH — известный pre-existing, не блокер.

- [ ] **Step 5: Прод/preview verify (главное доказательство)**

После деплоя превью/прод-сборки и реального трафика проверить в Sentry MCP:

- (а) Sentry **Logs пустые** — новых log-записей нет: `search_events(dataset='logs', statsPeriod='1h')` → 0.
- (б) `createLogger('smoke').warn('test')` и `.error('test', new Error())` → **Issue** с `tags.source=smoke`, stacktrace, replay.
- (в) extension-RangeError больше **не** заводит Issue (noise-filter дропнул) — issue KP-MODMB-COM-M без новых событий.

- [ ] **Step 6: Commit (kp)**

```bash
bash ~/.claude/scripts/commit-files.sh "chore(sentry): bump nuxt-sentry 0.7.0 (issues-first) + убрать log-only хак getOwnPropertyDescriptor" nuxt.config.ts package.json bun.lock
```

- [ ] **Step 7: Стоп — отчёт + push?**

Не пушить (ни модуль, ни kp) без явного разрешения. Резюме: что изменено, результаты verify. Rollout на ai/easy2/vincera — отдельные сессии (Phase 3, см. спеку §5).

---

## Self-Review

**1. Покрытие спеки:**

- §3.1 client init → Task 4 ✓
- §3.2 server init → Task 5 ✓
- §3.3 logger reshape → Task 2 (server) + Task 3 (client) ✓
- §3.4 noise-stack-filter → Task 1 ✓ (+ inline beforeSend в Tasks 4/5)
- §3.5 context max (replay 1.0, source maps) → Task 4 step f + Task 8 step 3 ✓
- §4 kp validation → Task 8 ✓
- §6 tests → Tasks 1/2/3 + Task 6 ✓
- §5 rollout → вне scope плана (Task 8 step 7 помечает как отдельные сессии) ✓

**2. Placeholder-скан:** код предиката/логгеров/тестов — реальный. «server ignoreErrors subset — решить если проблема резолва» и «source maps — отметить если не настроено» — это conditional verify-шаги с дефолтом, не placeholder. ✓

**3. Консистентность:** `isNoiseEvent` (Task 1) используется в Tasks 4/5 одинаково. `LoggerSink.withSourceScope(tag, extra, write)` сигнатура едина в Task 2 (impl + test). `createLogger`/`createLoggerWithSink` имена сохранены (back-compat). version 0.7.0 в Task 7 = bump в Task 8. ✓
