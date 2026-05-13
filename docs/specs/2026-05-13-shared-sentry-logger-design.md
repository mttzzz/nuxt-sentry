# Shared Sentry / Logger Module — Design

**Author:** Claude
**Date:** 2026-05-13
**Status:** Proposed
**Pkg:** `@mttzzz/nuxt-sentry`
**Target version:** 0.3.0

---

## 1. Context

Три Nuxt-проекта (`ai.pushka.biz`, `easy2.pushka.biz`, `kp.modmb.com`) уже подключены к `@mttzzz/nuxt-sentry` v0.2.0, который даёт init Sentry для Bun, client plugin, error-capture nitro plugin, user-context, tunnel handler, и portable `instrumentPostgresJs`.

Однако прикладная Sentry-обвязка (logger, scheduled-task wrapper, Bull queue tracing, cron monitor, error-report builder) разъехалась по проектам в трёх копиях разной зрелости:

| Артефакт                             | ai.pushka.biz                                                                     | easy2.pushka.biz                                                    | kp.modmb.com                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `server/utils/logger.ts`             | ★ canonical: 4 уровня, DI sink, breadcrumbs, captureMessage fallback (139 usages) | старый: только `error()`, consola, без debug/info/warn (182 usages) | минимум: `warn`+`error`, **console-only, без Sentry** (17 usages) |
| `app/utils/logger.ts` (client)       | warn+error, без явного captureException                                           | error-only, опирается на `consoleLoggingIntegration`                | отсутствует                                                       |
| `server/utils/sentry-cron.ts`        | ✅ `withCronMonitor`                                                              | ✅ identical                                                        | — (нет cron'ов)                                                   |
| `server/utils/sentry-queue.ts`       | ✅ Bull producer/consumer                                                         | ✅ identical                                                        | — (нет Bull)                                                      |
| `server/utils/sentry-report.ts`      | ✅ `buildSentryReport` (extras: cause, appData)                                   | —                                                                   | —                                                                 |
| `server/utils/define-sentry-task.ts` | ✅ обёртка (10 task'ов мигрированы)                                               | — (4 task'а под миграцию)                                           | —                                                                 |
| Кастомный nitro `error`-hook         | ✅ `error-handler.ts` дублирует pkg's `plugin-capture-errors`                     | —                                                                   | —                                                                 |

Контейнер для шаринга уже существует. Цель спека — канонизировать `ai.pushka.biz`-версии и довести pkg до состояния, где **проектные `server/utils/{logger,sentry-cron,sentry-queue,sentry-report,define-sentry-task}.ts` полностью удаляются**.

## 2. Goals

- Один источник правды для логгера и Sentry-обвязки во всех Nuxt-проектах организации.
- Обратная совместимость API: `createLogger(tag).error(...)` продолжает работать в easy2/kp без переписывания call-site'ов.
- KP получает Sentry-интеграцию логгера бесплатно (без переписывания 17 call-site'ов).
- Easy2 получает 4-уровневый logger + `defineSentryTask` (4 task'а становятся консистентны с ai).
- Решить дубликат error-hook в ai: pkg позволяет обогатить отчёт через опции, локальный `error-handler.ts` удаляется.
- Tree-shakeable sub-path exports — kp без Bull не получает `bull` в `node_modules`.
- Auto-import logger / cron / task в server (как сейчас работает `instrumentPostgresJs`).
- Каждый submodule покрыт unit-тестами в pkg.

## 3. Non-goals

- **Не** переходим с `@sentry/bun` на `@sentry/node` или универсальный SDK — все три проекта на Bun, peer-dep `@sentry/bun` сохраняем.
- **Не** добавляем новые runtime-зависимости (никакого `pino`/`winston`). Logger остаётся `console.*`-based.
- **Не** меняем поведение client-side Sentry (`@sentry/vue` consoleLoggingIntegration). Client logger получит явный `captureException`, но без переключения SDK.
- **Не** трогаем `better-auth-logger.ts` в проектах — это адаптер для библиотеки, не общий logger.
- **Не** делаем log-level конфигурируемым через runtime env (`LOG_LEVEL=debug`). YAGNI: все три проекта работают с фиксированным production-gate.
- **Не** мигрируем consumer-проекты в этом спеке. Здесь — только pkg API. Миграция — отдельные PR'ы (план в §8).

## 4. Architecture

### 4.1. Layout пакета

```
src/
├── module.ts                                ← Nuxt module (existing)
├── runtime/
│   ├── instrument.server.ts                 ← Sentry init for Bun (existing)
│   ├── plugin.client.ts                     ← @sentry/vue init (existing)
│   ├── server/
│   │   ├── plugin-capture-errors.ts         ← nitro error-hook (EXTENDED, см. §4.6)
│   │   ├── plugin-user-context.ts           ← (existing)
│   │   └── tunnel.post.ts                   ← (existing)
│   └── utils/
│       ├── instrument-postgres-js.ts        ← (existing, /utils export)
│       ├── capture-nitro-error.ts           ← (EXTENDED: optional report-builder + filter)
│       ├── ignore-errors.ts                 ← (existing)
│       ├── sentry-enabled.ts                ← (existing)
│       ├── tunnel-ingest-url.ts             ← (existing)
│       │
│       ├── logger.ts                        ← NEW (auto-import, /logger export)
│       ├── client-logger.ts                 ← NEW (client-only, /logger export, conditional)
│       ├── sentry-cron.ts                   ← NEW (auto-import, /cron export)
│       ├── sentry-queue.ts                  ← NEW (explicit import, /queue export)
│       ├── define-sentry-task.ts            ← NEW (auto-import, /task export)
│       └── sentry-report.ts                 ← NEW (used by capture-nitro-error)
└── runtime/types.ts                         ← (existing, EXTENDED для error-hook config)
```

### 4.2. `package.json` exports map

```json
{
  "exports": {
    ".": { "types": "./dist/types.d.mts", "import": "./dist/module.mjs" },
    "./utils": {
      "types": "./dist/runtime/utils/instrument-postgres-js.d.ts",
      "import": "./dist/runtime/utils/instrument-postgres-js.js"
    },
    "./logger": { "types": "./dist/runtime/utils/logger.d.ts", "import": "./dist/runtime/utils/logger.js" },
    "./logger/client": {
      "types": "./dist/runtime/utils/client-logger.d.ts",
      "import": "./dist/runtime/utils/client-logger.js"
    },
    "./cron": { "types": "./dist/runtime/utils/sentry-cron.d.ts", "import": "./dist/runtime/utils/sentry-cron.js" },
    "./queue": { "types": "./dist/runtime/utils/sentry-queue.d.ts", "import": "./dist/runtime/utils/sentry-queue.js" },
    "./task": {
      "types": "./dist/runtime/utils/define-sentry-task.d.ts",
      "import": "./dist/runtime/utils/define-sentry-task.js"
    }
  },
  "peerDependencies": {
    "@sentry/bun": "^10.52.0",
    "@sentry/core": "^10.52.0",
    "@sentry/vite-plugin": "^5.0.0",
    "@sentry/vue": "^10.52.0",
    "nuxt": "^4.4.5",
    "bull": "^4.0.0"
  },
  "peerDependenciesMeta": {
    "bull": { "optional": true }
  }
}
```

`bull` opt-in: kp не импортит `/queue` → `bun install` не требует bull, тип `Queue.Queue<T>` доступен только при наличии пакета.

### 4.3. Auto-imports

В `module.ts` добавляем `addServerImports([...])`:

```ts
addServerImports([
  { name: 'createLogger', from: resolver.resolve('./runtime/utils/logger') },
  { name: 'createLoggerWithSink', from: resolver.resolve('./runtime/utils/logger') },
  { name: 'withCronMonitor', from: resolver.resolve('./runtime/utils/sentry-cron') },
  { name: 'defineSentryTask', from: resolver.resolve('./runtime/utils/define-sentry-task') },
])
```

Client-side logger (`/logger/client`) — НЕ auto-import: на client `app/`-слой не имеет nitro-style auto-import'а через addServerImports, а через `addImports` это тянет `@sentry/vue` в каждый чанк. Регистрируем через `addImportsDir` нацеленный на client-only-utils — определю в plan'е.

Регистрация ДО `_prepare`-гейта (как сейчас для `instrumentPostgresJs`), чтобы `nuxi prepare` на consumer'е увидел типы.

### 4.4. Public API: `@mttzzz/nuxt-sentry/logger` (server)

```ts
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

export function createLogger(tag: string): Logger
export function createLoggerWithSink(tag: string, sink: LoggerSink): Logger // for tests
```

**Семантика уровней** (как в ai-canonical):

- `debug` — console-only, off в production
- `info` — console + Sentry breadcrumb (level=info)
- `warn` — console + Sentry breadcrumb (level=warning)
- `error` — console + если есть `Error` в args → `captureException`, иначе `captureMessage` с `level=error`. Тег `source: <tag>` всегда.

**Cache:** `Map<string, Logger>` инстансов по тегу — `createLogger('foo')` дважды возвращает один объект. Cache живёт в module scope (singleton за процесс).

**Compat для easy2/kp:** старый call `createLogger('amo-sync').error('...', err)` работает идентично — тот же сигнатур, тот же поведение для `.error()`. Просто `.warn() / .info() / .debug()` теперь доступны.

### 4.5. Public API: `@mttzzz/nuxt-sentry/logger/client`

```ts
export interface ClientLogger {
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}
export function createLogger(tag: string): ClientLogger
```

`.error()` делает `Sentry.captureException(firstErrorArg ?? new Error(message), { tags: { source: tag } })` явно (не полагается на `consoleLoggingIntegration`). `.warn()` — `console.warn` + `Sentry.addBreadcrumb({ level: 'warning' })`.

`consola` зависимость **дропается** — `console.error`/`console.warn` через `@sentry/vue` уже даёт нужный лог в DevTools, а Sentry capture делается явно.

Модуль `consola` остаётся доступен в проекте (Nuxt builtin), но pkg-logger его не использует.

### 4.6. Public API: `@mttzzz/nuxt-sentry/cron`

```ts
export interface CronMonitorOptions {
  checkinMargin?: number // default 2
  maxRuntime?: number // default 10
  timezone?: string // default 'Etc/UTC'
}

export async function withCronMonitor<T>(
  slug: string,
  schedule: string,
  fn: () => Promise<T>,
  options?: CronMonitorOptions,
): Promise<T>
```

Идентично текущей ai/easy2 версии. Используется внутри `defineSentryTask`, экспортится отдельно для случаев, когда нужен cron-monitor вне Nitro task'а (например, manual scheduler).

### 4.7. Public API: `@mttzzz/nuxt-sentry/queue`

```ts
import type Queue from 'bull' // peer-dep, type-only import

export function instrumentQueueProducer<T>(queue: Queue.Queue<T>): Queue.Queue<T>
export async function withSentryConsumer<T, R>(queueName: string, job: Queue.Job<T>, fn: () => Promise<R>): Promise<R>
```

Идентично ai/easy2. Trace-headers через `_sentryTrace` / `_sentryBaggage` / `_sentryPublishedAt` в job-data; `instrumentQueueProducer` — monkey-patch `.add()` для inject'а headers; `withSentryConsumer` — extract + `Sentry.continueTrace`.

KP не импортит `/queue` — `bull` опционален.

### 4.8. Public API: `@mttzzz/nuxt-sentry/task`

```ts
export interface SentryTaskMeta {
  name: string
  description: string
  cron?: string
}

export interface SentryTaskOutcome {
  result: 'success' | 'error'
  message?: string
  [key: string]: unknown
}

export function defineSentryTask<R extends Record<string, unknown>>(opts: {
  meta: SentryTaskMeta
  run: (ctx: { logger: Logger }) => Promise<R>
}): ReturnType<typeof defineTask>
```

Семантика:

1. `Sentry.startNewTrace` — новый trace на каждый запуск.
2. `Sentry.startSpan({ op: 'task', name })` — длительность в Performance.
3. Если `meta.cron` указан — оборачиваем в `Sentry.withMonitor` (Sentry Crons check-in).
4. Logger создаётся с тегом `task:<name>` и приходит в `run`-callback. Возможный override `loggerTag?: string` — отложен, YAGNI.
5. Catch внутри: `logger.error('Task <name> failed', err)` → возвращаем `{ result: 'error', message }`. Никогда не пробрасываем — Nitro task runner не интегрирован с error-hook'ом.

**Pure body** `runSentryTaskBody({ meta, run, logger, sentry })` экспортится как internal для unit-тестов pkg (не в public exports map).

### 4.9. Extended: `plugin-capture-errors` + `captureNitroError`

Текущая проблема (ai): pkg's `plugin-capture-errors` ловит ошибку без extras + локальный `error-handler.ts` ловит ту же ошибку с `buildSentryReport` (extras: cause, appData) → каждая 5xx уходит в Sentry **дважды** (с разным контекстом).

Решение в pkg:

- `captureNitroError` обогащается до уровня ai-canonical: всегда вытаскивает `error.cause`, `error.data` (h3 createError data — наш AppErrorData), URL/method/headers из event.
- Module accepts две опции — обе функции, optional:

```ts
export interface ModuleOptions {
  // ...existing...
  errorReportFilter?: (error: unknown) => boolean
  errorReportEnricher?: (
    error: unknown,
    event?: H3Event,
  ) => { extra?: Record<string, unknown>; tags?: Record<string, string> }
}
```

- `errorReportFilter` — return `false` → пропустить событие. AI передаёт `shouldReportProductionError` (skip "Cannot find static asset" и 4xx).
- `errorReportEnricher` — добавляет project-specific extras/tags поверх дефолтных.

После релиза ai удаляет `server/plugins/error-handler.ts` + `server/utils/error-handler-filter.ts` + `server/utils/sentry-report.ts`, передаёт filter через `nuxt.config.ts`:

```ts
sentry: {
  dsn: '...',
  errorReportFilter: shouldReportProductionError,  // импорт из server/utils
}
```

Опции — функции — попадают в build-time через `addTemplate` (как `tracePropagationTargets`) — нужно сериализовать function-literal'ом, не JSON. Альтернатива: принимать **относительные пути** к модулям, pkg добавляет import в plugin. Принимаем path-based вариант — сериализация function в build-config хрупко (closure'ы, scope), path-based — детерминирован.

```ts
sentry: {
  errorReportFilter: '~/server/utils/error-handler-filter',  // module path, default export
  errorReportEnricher: '~/server/utils/sentry-report-enricher',  // optional
}
```

В pkg-`plugin-capture-errors`:

```ts
import filter from '#nuxt-sentry/error-filter' // virtual, resolved by module
import enricher from '#nuxt-sentry/error-enricher'
```

Module template emits эти virtuals — если опция не задана, экспортит no-op (`() => true` / `() => ({})`).

### 4.10. Note: `sentry-report.ts` — internal helper, не submodule

`buildSentryReport` живёт в `runtime/utils/sentry-report.ts` как helper для `captureNitroError`. **Не** экспортится через `package.json` exports — пользователь не должен его звать напрямую. Если в будущем понадобится snapshot ai's API — добавим в exports отдельной версией.

`/utils` остаётся узким — только `instrumentPostgresJs`. Не превращаем его в barrel «всё подряд», чтобы tree-shaking оставался предсказуемым.

## 5. Customization points

| Опция                                       | Default                   | Use case                                                |
| ------------------------------------------- | ------------------------- | ------------------------------------------------------- |
| `LoggerSink` (через `createLoggerWithSink`) | production-aware Bun sink | unit-тесты с мокнутым Sentry, кастом для тестов проекта |
| `errorReportFilter` (module option, path)   | `() => true`              | ai's "Cannot find static asset" skip                    |
| `errorReportEnricher` (module option, path) | `() => ({})`              | ai's `cause`/`appData` extras                           |
| `defineSentryTask`: `loggerTag` override    | `task:<name>`             | YAGNI, **отложено**                                     |
| Logger log-level threshold через env        | `debug` off в prod        | YAGNI, **отложено**                                     |

## 6. Removed/deprecated

После раскатки удаляются из проектов:

- `server/utils/logger.ts` × 3
- `app/utils/logger.ts` × 2 (ai, easy2)
- `server/utils/sentry-cron.ts` × 2 (ai, easy2)
- `server/utils/sentry-queue.ts` × 2 (ai, easy2)
- `server/utils/sentry-report.ts` × 1 (ai)
- `server/utils/define-sentry-task.ts` × 1 (ai)
- `server/utils/error-handler-filter.ts` × 1 (ai) — переезжает в проектный `~/server/utils/error-filter.ts` либо в config inline
- `server/plugins/error-handler.ts` × 1 (ai) — pkg-plugin теперь делает то же

Также удаляется `server/plugins/__tests__/...` и `test/unit/server/sentry-report.test.ts` (ai) — их заменяют тесты pkg.

## 7. Testing strategy

В pkg `test/unit/`:

| File                          | Coverage                                                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `logger.test.ts`              | `createLoggerWithSink` — все 4 уровня, production gate, breadcrumb dispatch, Error-detection в args для captureException, fallback на captureMessage, source-tag wiring, cache idempotency |
| `client-logger.test.ts`       | `error()` явно captures, `warn()` adds breadcrumb                                                                                                                                          |
| `sentry-cron.test.ts`         | `withCronMonitor` передаёт правильный schedule shape в `Sentry.withMonitor`                                                                                                                |
| `sentry-queue.test.ts`        | `instrumentQueueProducer.add` инжектит trace headers, namespace-style и default-style; `withSentryConsumer` continues trace from headers, без headers — startNewTrace                      |
| `define-sentry-task.test.ts`  | `runSentryTaskBody` success path возвращает `{ result: 'success', ...data }`; error path → `{ result: 'error', message }`; cron-режим зовёт withMonitor; not-cron — startNewTrace          |
| `capture-nitro-error.test.ts` | filter (`() => false` skip), enricher merge, default 4xx skip, default extras (URL/method/headers/cause/appData)                                                                           |

Все тесты — DI/mocked, без реального `@sentry/bun` (через sink/runtime injection). Existing pkg tests (`tunnel-ingest-url`, `instrument-postgres-js`, `ignore-errors`) сохраняются.

В playground добавляем smoke-test: server-route, который дёргает `createLogger('demo').warn(...)` + бросает 500, проверяем что Sentry получает событие через мокнутый transport.

В consumer-проектах (ai/easy2/kp) — заменяем existing logger tests на smoke (импорт из pkg, не дублируем покрытие). Existing ai's `define-sentry-task` integration test остаётся как regression check.

## 8. Migration plan (фазы)

Каждая фаза — отдельный PR на свой репо.

### Phase 1: pkg release v0.3.0

1. Реализация в `~/projects/nuxt-sentry/`:
   - 5 новых утилит в `src/runtime/utils/`
   - расширение `module.ts` (`addServerImports`, error-pipeline templates)
   - расширение `capture-nitro-error.ts` + `plugin-capture-errors.ts`
   - exports map в `package.json`
   - `peerDependenciesMeta.bull.optional`
   - tests + playground smoke
2. `nuxt-module-build build` → `dist/` коммитится (как сейчас, для github:-deps).
3. Bump `version: 0.3.0` + tag.

### Phase 2: easy2.pushka.biz migration

1. `bun update @mttzzz/nuxt-sentry`
2. Удалить `server/utils/{logger,sentry-cron,sentry-queue}.ts` + `app/utils/logger.ts`. Auto-import pkg-версии.
3. Мигрировать 4 task'а с `defineTask + withCronMonitor` → `defineSentryTask({ meta: { name, description, cron } })`.
4. `bun fmt + lint:fix + typecheck + test` (по project params).
5. Verify: signup race-test зелёный, существующий тест `payment-sync` работает.

### Phase 3: kp.modmb.com migration

1. `bun update @mttzzz/nuxt-sentry`
2. Удалить `server/utils/logger.ts`. Auto-import pkg-версии. **17 call-site'ов** не меняются — API совместим.
3. `bun fmt + lint:fix + typecheck + test`.
4. Verify: smoke test `createLogger('test').error('msg', new Error('x'))` → событие в Sentry-test-DSN.

### Phase 4: ai.pushka.biz migration

1. `bun update @mttzzz/nuxt-sentry`
2. Удалить `server/utils/{logger,sentry-cron,sentry-queue,sentry-report,define-sentry-task}.ts` + `server/plugins/error-handler.ts` + `app/utils/logger.ts`.
3. Перевести `error-handler-filter.ts` → `server/utils/error-filter.ts` (default export для path-based config).
4. `nuxt.config.ts` → `sentry: { errorReportFilter: '~/server/utils/error-filter', errorReportEnricher: '~/server/utils/error-enricher' }` (новый файл, инкапсулирует логику cause/appData).
5. `bun fmt + lint:fix + typecheck + test`.
6. Verify: integration test для error-hook'а ловит 5xx с правильными extras; нет дубликатов в Sentry-test-DSN.

## 9. Versioning & rollout

- `@mttzzz/nuxt-sentry@0.3.0` — additive, no break для consumer'ов, использующих только текущий public API (module + `/utils`-экспорт).
- **Single-bump rule**: после release → все три проекта обновляют lockfile в течение одной сессии. Минимизирует drift.
- Если в Phase 2-4 находим bug в pkg — pkg-патч `0.3.x`, проекты bump'ят следом.

## 10. Risks & mitigations

| Risk                                                                                                                                                   | Mitigation                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Auto-import конфликт: проект имеет свой `createLogger` в `server/utils/` → две регистрации                                                             | Phase 2-4 удаляют local `logger.ts` ДО bump → конфликт невозможен. Лог-сообщение `nuxi prepare` поможет диагностировать.                 |
| `bull` peer-warning у kp при `bun install`                                                                                                             | `peerDependenciesMeta.bull.optional=true` — bun не предупреждает. Verify in Phase 3.                                                     |
| Path-based `errorReportFilter`: путь резолвится в build-time, but Nitro context не имеет alias `~` для server → надо использовать `nuxt.options.alias` | Module добавляет `nuxt.options.nitro.alias['#nuxt-sentry/error-filter'] = resolved.path`. Аналог уже работает для `#nuxt-sentry/config`. |
| Existing ai's `define-sentry-task.test.ts` ломается из-за импорта пути                                                                                 | Test переезжает в pkg; ai-side остаётся integration-тест на конкретный task (e.g. `vercel:check-balance`).                               |
| Client logger потеряет `consola.withTag` форматирование DevTools                                                                                       | Pkg client logger форматирует prefix `[<tag>]` сам, как server logger. Визуально сравнимо.                                               |

## 11. Open questions

1. **Path-based callbacks vs inline functions:** path-based выбран как детерминированный. Если пользователь предпочитает inline lambda — это решается отдельно через separate template-emission, но усложняет module. **Решение по умолчанию: path-based.**
2. **Logger cache scope:** singleton в module scope. В Nitro каждый worker — свой процесс → cache живёт per-worker, не shared. ОК для тегов; не пытаемся cross-worker dedup.
3. **`Sentry.withMonitor` для long task'ов:** `maxRuntime: 10` (минут) — дефолт текущей ai-версии. Action item Phase 1: проверить grep'ом по ai/easy2 task'ам, есть ли cron'ы, чьё ожидаемое время > 10 мин (`media-process`, `amo-sync` — кандидаты). Если да — поднять дефолт или сделать per-task override через `meta.maxRuntime`.
