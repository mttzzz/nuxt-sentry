/*
 * Prisma variant of Server Sentry init.
 *
 * Kept as a separate entry so non-Prisma projects (`db: 'postgres-js'`, `pg`,
 * `mysql2`, or `false`) do not need to resolve/import the optional
 * `@prisma/instrumentation` peer at build time.
 */

import { PrismaInstrumentation } from '@prisma/instrumentation'
import * as Sentry from '@sentry/bun'

import { createPrismaSpanNormalizer } from './utils/prisma-span-normalize'
import { shouldEnableServerSentry } from './utils/sentry-enabled'

declare const __NUXT_SENTRY_DSN__: string
declare const __NUXT_SENTRY_CACHE_PREFIX__: string
declare const __NUXT_SENTRY_TRACES_SAMPLE_RATE__: number
declare const __NUXT_SENTRY_IGNORED_ROUTES__: string[]

const normalizePrismaQuerySpan = createPrismaSpanNormalizer()

Sentry.init({
  dsn: __NUXT_SENTRY_DSN__,

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
    Sentry.prismaIntegration({
      prismaInstrumentation: new PrismaInstrumentation(),
    }),
  ],

  tracesSampler: ({ name }: { name?: string }) => {
    if (name?.startsWith('queue.publish/') || name?.startsWith('queue.process/')) {
      return 1
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

  beforeSendSpan: span => normalizePrismaQuerySpan(span),

  debug: false,
})
