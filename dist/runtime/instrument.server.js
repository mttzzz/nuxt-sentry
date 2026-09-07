import * as Sentry from "@sentry/bun";
import { isNoiseEvent, normalizeConsoleEvent, normalizeMessageEvent } from "./utils/before-send.js";
import { shouldEnableServerSentry } from "./utils/sentry-enabled.js";
function readEnvVolatile(key) {
  return globalThis.process?.env?.[key];
}
Error.stackTraceLimit = 50;
Sentry.init({
  dsn: __NUXT_SENTRY_DSN__,
  release: __NUXT_SENTRY_RELEASE__,
  enabled: shouldEnableServerSentry({
    nodeEnv: readEnvVolatile("NODE_ENV"),
    sentryDisabled: readEnvVolatile("SENTRY_DISABLED")
  }),
  integrations: [
    /* Explicitly keep Bun HTTP transactions even if SDK defaults change. */
    Sentry.bunServerIntegration(),
    Sentry.redisIntegration({
      cachePrefixes: [__NUXT_SENTRY_CACHE_PREFIX__]
    }),
    /* Issues-first: серверный console.warn/error → Issue (через createLogger или сырой). */
    Sentry.captureConsoleIntegration({ levels: ["warn", "error"] })
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
  enableLogs: false,
  /* Дропаем anonymous-recursion/extension шум (под catch-all message-ignoreErrors его не ловит),
     затем нормализуем console-события (читаемый заголовок + culprit на реальном вызывающем) и
     прямые captureMessage (заголовок — текст сообщения, а не функция кадра). */
  beforeSend: (event) => isNoiseEvent(event) ? null : normalizeMessageEvent(normalizeConsoleEvent(event)),
  debug: false
});
