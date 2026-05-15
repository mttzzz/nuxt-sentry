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

import { shouldEnableServerSentry } from './utils/sentry-enabled'

// oxlint-disable no-underscore-dangle -- build-time placeholders replaced by renderChunk in module.ts; naming convention required by token-substitution regex
declare const __NUXT_SENTRY_DSN__: string
declare const __NUXT_SENTRY_CACHE_PREFIX__: string
declare const __NUXT_SENTRY_TRACES_SAMPLE_RATE__: number
declare const __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__: number
declare const __NUXT_SENTRY_IGNORED_ROUTES__: string[]
declare const __NUXT_SENTRY_RELEASE__: string | undefined
// oxlint-enable no-underscore-dangle

Sentry.init({
  dsn: __NUXT_SENTRY_DSN__,
  release: __NUXT_SENTRY_RELEASE__,

  enabled: shouldEnableServerSentry({
    nodeEnv: process.env.NODE_ENV,
    sentryDisabled: process.env.SENTRY_DISABLED,
  }),

  integrations: [
    /* Explicitly keep Bun HTTP transactions even if SDK defaults change. */
    Sentry.bunServerIntegration(),
    Sentry.redisIntegration({
      cachePrefixes: [__NUXT_SENTRY_CACHE_PREFIX__],
    }),
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
  enableLogs: true,

  debug: false,
})
