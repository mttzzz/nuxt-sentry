/*
 * Server Sentry init. Этот файл инжектится модулем как top-level rollup chunk
 * в Nitro server entry — выполняется ДО любого application code, чтобы
 * `@prisma/instrumentation` + Redis OTEL успели обернуть драйверы.
 *
 * Project-specific значения (DSN, cachePrefix, tracesSampleRate, ignoredRoutes)
 * приходят из build-time темплейта `#build/nuxt-sentry-build-config`,
 * сгенерированного `addTemplate` в src/module.ts.
 */

import { PrismaInstrumentation } from '@prisma/instrumentation'
import * as Sentry from '@sentry/bun'

// @ts-expect-error virtual module emitted by module.ts via addTemplate + nitro.alias
import { cachePrefix, dsn, ignoredRoutes, tracesSampleRate } from '#nuxt-sentry/config'

import { createPrismaSpanNormalizer } from './utils/prisma-span-normalize'
import { shouldEnableServerSentry } from './utils/sentry-enabled'

const normalizePrismaQuerySpan = createPrismaSpanNormalizer()

Sentry.init({
  dsn,

  enabled: shouldEnableServerSentry({
    nodeEnv: process.env.NODE_ENV,
    sentryDisabled: process.env.SENTRY_DISABLED,
  }),

  integrations: [
    Sentry.redisIntegration({
      cachePrefixes: [cachePrefix],
    }),
    Sentry.prismaIntegration({
      prismaInstrumentation: new PrismaInstrumentation(),
    }),
  ],

  tracesSampler: ({ name }: { name?: string }) => {
    if (name?.startsWith('queue.publish/') || name?.startsWith('queue.process/')) {
      return 1
    }
    if (name && (ignoredRoutes as string[]).some((route: string) => name.startsWith(route))) {
      return 0
    }
    return tracesSampleRate
  },

  sendDefaultPii: true,
  attachStacktrace: true,
  normalizeDepth: 8,
  enableLogs: true,

  beforeSendSpan: span => normalizePrismaQuerySpan(span),

  debug: false,
})
