import * as Sentry from "@sentry/bun";
import { shouldEnableServerSentry } from "./utils/sentry-enabled.js";
import { buildServerSentryOptions } from "./utils/server-init-options.js";
function readEnvVolatile(key) {
  return globalThis.process?.env?.[key];
}
Error.stackTraceLimit = 50;
Sentry.init(
  buildServerSentryOptions({
    dsn: __NUXT_SENTRY_DSN__,
    release: __NUXT_SENTRY_RELEASE__,
    enabled: shouldEnableServerSentry({
      nodeEnv: readEnvVolatile("NODE_ENV"),
      sentryDisabled: readEnvVolatile("SENTRY_DISABLED")
    }),
    cachePrefix: __NUXT_SENTRY_CACHE_PREFIX__,
    tracesSampleRate: __NUXT_SENTRY_TRACES_SAMPLE_RATE__,
    queueTracesSampleRate: __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__,
    ignoredRoutes: __NUXT_SENTRY_IGNORED_ROUTES__
  })
);
