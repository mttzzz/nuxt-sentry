/*
 * Server Sentry init. Этот файл инжектится модулем как top-level rollup chunk
 * в Nitro server entry — выполняется ДО любого application code, чтобы
 * Sentry успел обернуть Bun.serve и redis.
 *
 * Project-specific значения (DSN, cachePrefix, tracesSampleRate, ignoredRoutes)
 * подставляются build-time через string-substitution в `renderChunk`-хуке
 * (см. src/module.ts). НЕ импортируем их через alias — instrument грузится
 * раньше index.mjs, импорт оттуда → TDZ.
 *
 * Сами опции собирает utils/server-init-options.ts (чистая функция: итоговая конфигурация
 * проверяется в тестах настоящим SDK; здесь остаются только плейсхолдеры и побочные эффекты).
 *
 * DB-инструментация (postgres-js) выполняется НЕ здесь, а ручным вызовом
 * `instrumentPostgresJs(client)` в `server/db/client.ts` консьюмера: Nitro бандлит `postgres`
 * в один файл, и автоматическому патчу модуля там нечего подменять. Подробнее: runtime/utils/instrument-postgres-js.ts.
 */

import * as Sentry from '@sentry/bun'

import { shouldEnableServerSentry } from './utils/sentry-enabled'
import { buildServerSentryOptions } from './utils/server-init-options'

/* Volatile env read через globalThis — обход Rollup constant-folding.
   `bun nuxt build` запускается с NODE_ENV=production, и плоский `process.env.NODE_ENV`
   bundler in-line'ит в литерал "production", потом DCE-вырезает `if (env.nodeEnv !== 'production')`
   из shouldEnableServerSentry, и runtime-флаг NODE_ENV перестаёт работать (build artifact
   проверял только SENTRY_DISABLED). Через globalThis bundler не может статически резолвить
   → проверка остаётся в runtime. */
function readEnvVolatile(key: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key]
}

// oxlint-disable no-underscore-dangle -- build-time placeholders replaced by renderChunk in module.ts; naming convention required by token-substitution regex
declare const __NUXT_SENTRY_DSN__: string
declare const __NUXT_SENTRY_CACHE_PREFIX__: string
declare const __NUXT_SENTRY_TRACES_SAMPLE_RATE__: number
declare const __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__: number
declare const __NUXT_SENTRY_IGNORED_ROUTES__: string[]
declare const __NUXT_SENTRY_RELEASE__: string | undefined
// oxlint-enable no-underscore-dangle

/* Синтетический стек console-события (captureConsoleIntegration → new Error()) должен доставать
 * до вызывающего logger.warn/error. Дефолт Bun/V8 — 10 кадров, а обвязка captureConsole +
 * withSourceScope + sink занимает ровно 10, когда @sentry/core идёт внешним пакетом: у всех
 * logger.error приложения был одинаковый стек из одной обвязки, и Sentry сливал их в один issue
 * (ai.pushka.biz AI-PUSHKA-BIZ-5J). 50 кадров — с запасом на async_hooks и вложенные обёртки. */
Error.stackTraceLimit = 50

Sentry.init(
  buildServerSentryOptions({
    dsn: __NUXT_SENTRY_DSN__,
    release: __NUXT_SENTRY_RELEASE__,
    enabled: shouldEnableServerSentry({
      nodeEnv: readEnvVolatile('NODE_ENV'),
      sentryDisabled: readEnvVolatile('SENTRY_DISABLED'),
    }),
    cachePrefix: __NUXT_SENTRY_CACHE_PREFIX__,
    tracesSampleRate: __NUXT_SENTRY_TRACES_SAMPLE_RATE__,
    queueTracesSampleRate: __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__,
    ignoredRoutes: __NUXT_SENTRY_IGNORED_ROUTES__,
  }),
)
