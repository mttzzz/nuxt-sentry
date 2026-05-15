import * as Sentry from "@sentry/bun";
import { shouldEnableServerSentry } from "./utils/sentry-enabled.js";
Sentry.init({
  dsn: __NUXT_SENTRY_DSN__,
  release: __NUXT_SENTRY_RELEASE__,
  enabled: shouldEnableServerSentry({
    nodeEnv: process.env.NODE_ENV,
    sentryDisabled: process.env.SENTRY_DISABLED
  }),
  integrations: [
    /* Explicitly keep Bun HTTP transactions even if SDK defaults change. */
    Sentry.bunServerIntegration(),
    Sentry.redisIntegration({
      cachePrefixes: [__NUXT_SENTRY_CACHE_PREFIX__]
    })
  ],
  tracesSampler: ({ name }) => {
    if (name?.startsWith("queue.publish/") || name?.startsWith("queue.process/")) {
      return __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__;
    }
    if (name && __NUXT_SENTRY_IGNORED_ROUTES__.some((route) => name.startsWith(route))) {
      return 0;
    }
    return __NUXT_SENTRY_TRACES_SAMPLE_RATE__;
  },
  sendDefaultPii: true,
  attachStacktrace: true,
  normalizeDepth: 8,
  enableLogs: true,
  debug: false
});
