/*
 * Server Sentry init. Этот файл инжектится модулем как top-level rollup chunk
 * в Nitro server entry — выполняется ДО любого application code, чтобы
 * Sentry + OTEL успели обернуть HTTP/Bun.serve и выбранный DB-драйвер.
 *
 * Project-specific значения (DSN, cachePrefix, db, tracesSampleRate, ignoredRoutes)
 * подставляются build-time через string-substitution в `renderChunk`-хуке
 * (см. src/module.ts). НЕ импортируем их через alias — instrument грузится
 * раньше index.mjs, импорт оттуда → TDZ.
 */

import type { Integration } from '@sentry/core'
import * as Sentry from '@sentry/bun'

import { shouldEnableServerSentry } from './utils/sentry-enabled'

declare const __NUXT_SENTRY_DSN__: string
declare const __NUXT_SENTRY_CACHE_PREFIX__: string
declare const __NUXT_SENTRY_DB__: 'postgres-js' | 'pg' | 'mysql2' | false
declare const __NUXT_SENTRY_TRACES_SAMPLE_RATE__: number
declare const __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__: number
declare const __NUXT_SENTRY_IGNORED_ROUTES__: string[]

function createDbIntegration(): Integration | undefined {
  switch (__NUXT_SENTRY_DB__) {
    case 'postgres-js':
      return Sentry.postgresJsIntegration()
    case 'pg':
      return Sentry.postgresIntegration()
    case 'mysql2':
      return Sentry.mysql2Integration()
    case false:
      return undefined
  }
}

const dbIntegration = createDbIntegration()
const integrations: Integration[] = [
  /* Explicitly keep Bun HTTP transactions even if SDK defaults change. */
  Sentry.bunServerIntegration(),
  Sentry.redisIntegration({
    cachePrefixes: [__NUXT_SENTRY_CACHE_PREFIX__],
  }),
]

if (dbIntegration) {
  integrations.push(dbIntegration)
}

Sentry.init({
  dsn: __NUXT_SENTRY_DSN__,

  enabled: shouldEnableServerSentry({
    nodeEnv: process.env.NODE_ENV,
    sentryDisabled: process.env.SENTRY_DISABLED,
  }),

  integrations,

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
