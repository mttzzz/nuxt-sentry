import { PrismaInstrumentation } from "@prisma/instrumentation";
import * as Sentry from "@sentry/bun";
import { cachePrefix, dsn, ignoredRoutes, tracesSampleRate } from "#nuxt-sentry/config";
import { createPrismaSpanNormalizer } from "./utils/prisma-span-normalize.js";
import { shouldEnableServerSentry } from "./utils/sentry-enabled.js";
const normalizePrismaQuerySpan = createPrismaSpanNormalizer();
Sentry.init({
  dsn,
  enabled: shouldEnableServerSentry({
    nodeEnv: process.env.NODE_ENV,
    sentryDisabled: process.env.SENTRY_DISABLED
  }),
  integrations: [
    Sentry.redisIntegration({
      cachePrefixes: [cachePrefix]
    }),
    Sentry.prismaIntegration({
      prismaInstrumentation: new PrismaInstrumentation()
    })
  ],
  tracesSampler: ({ name }) => {
    if (name?.startsWith("queue.publish/") || name?.startsWith("queue.process/")) {
      return 1;
    }
    if (name && ignoredRoutes.some((route) => name.startsWith(route))) {
      return 0;
    }
    return tracesSampleRate;
  },
  sendDefaultPii: true,
  attachStacktrace: true,
  normalizeDepth: 8,
  enableLogs: true,
  beforeSendSpan: (span) => normalizePrismaQuerySpan(span),
  debug: false
});
