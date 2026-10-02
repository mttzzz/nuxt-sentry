import * as Sentry from "@sentry/bun";
import { isNoiseEvent, normalizeConsoleEvent, normalizeMessageEvent } from "./utils/before-send.js";
import { shouldEnableServerSentry } from "./utils/sentry-enabled.js";
import { createTracesSampler } from "./utils/traces-sampler.js";
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
  /* Какие корневые спаны становятся транзакциями — utils/traces-sampler.ts (чистая фабрика, покрыта
     юнитами). Плейсхолдеры остаются тут: renderChunk подставляет их только в коде этого чанка. */
  tracesSampler: createTracesSampler({
    tracesSampleRate: __NUXT_SENTRY_TRACES_SAMPLE_RATE__,
    queueTracesSampleRate: __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__,
    ignoredRoutes: __NUXT_SENTRY_IGNORED_ROUTES__
  }),
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
