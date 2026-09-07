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
 * DB-инструментация (postgres-js) выполняется НЕ здесь, а ручным вызовом
 * `instrumentPostgresJs(client)` в `server/db/client.ts` консьюмера. Причина:
 * OTEL-инструментация Sentry'я полагается на `import-in-the-middle`, который
 * сломан на Bun — db-спаны не создаются. Подробнее: runtime/utils/instrument-postgres-js.ts.
 */

import * as Sentry from '@sentry/bun'

import { isNoiseEvent, normalizeConsoleEvent, normalizeMessageEvent } from './utils/before-send'
import { shouldEnableServerSentry } from './utils/sentry-enabled'

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

Sentry.init({
  dsn: __NUXT_SENTRY_DSN__,
  release: __NUXT_SENTRY_RELEASE__,

  enabled: shouldEnableServerSentry({
    nodeEnv: readEnvVolatile('NODE_ENV'),
    sentryDisabled: readEnvVolatile('SENTRY_DISABLED'),
  }),

  integrations: [
    /* Explicitly keep Bun HTTP transactions even if SDK defaults change. */
    Sentry.bunServerIntegration(),
    Sentry.redisIntegration({
      cachePrefixes: [__NUXT_SENTRY_CACHE_PREFIX__],
    }),
    /* Issues-first: серверный console.warn/error → Issue (через createLogger или сырой). */
    Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] }),
  ],

  tracesSampler: ({ name }: { name?: string }) => {
    if (name?.startsWith('queue.publish/') || name?.startsWith('queue.process/')) {
      return __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__
    }
    if (name && __NUXT_SENTRY_IGNORED_ROUTES__.some((route: string) => name.startsWith(route))) {
      return 0
    }
    return __NUXT_SENTRY_TRACES_SAMPLE_RATE__
  },

  sendDefaultPii: true,
  attachStacktrace: true,
  normalizeDepth: 8,
  enableLogs: false,

  /* Дропаем anonymous-recursion/extension шум (под catch-all message-ignoreErrors его не ловит),
     затем нормализуем console-события (читаемый заголовок + culprit на реальном вызывающем) и
     прямые captureMessage (заголовок — текст сообщения, а не функция кадра). */
  beforeSend: (event) => (isNoiseEvent(event) ? null : normalizeMessageEvent(normalizeConsoleEvent(event))),

  debug: false,
})
