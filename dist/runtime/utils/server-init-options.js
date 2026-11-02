import * as Sentry from "@sentry/bun";
import { isNoiseEvent, normalizeConsoleEvent, normalizeMessageEvent } from "./before-send.js";
import { DATA_COLLECTION } from "./data-collection.js";
import { createTracesSampler } from "./traces-sampler.js";
const DROPPED_DEFAULT_INTEGRATIONS = { Fetch: true, Dedupe: true, NodeSystemError: true };
export function buildServerIntegrations(defaults, cachePrefix) {
  return [
    ...defaults.filter(({ name }) => !Object.hasOwn(DROPPED_DEFAULT_INTEGRATIONS, name)),
    /* Явный экземпляр с настройками, а не дефолт: Bun.serve ядра (публичный и внутренний порт). */
    Sentry.bunServerIntegration({ maxRequestBodySize: "none", sessions: false }),
    /* Серверы на node:http внутри процесса (Bun не публикует http.server.request.start). */
    Sentry.bunHttpServerIntegration({ maxRequestBodySize: "none", sessions: false }),
    Sentry.redisIntegration({ cachePrefixes: [cachePrefix] }),
    /* Issues-first: серверный console.warn/error → Issue (через createLogger или сырой). */
    Sentry.captureConsoleIntegration({ levels: ["warn", "error"] })
  ];
}
function serverBeforeSend(event) {
  return isNoiseEvent(event) ? null : normalizeMessageEvent(normalizeConsoleEvent(event));
}
export function buildServerSentryOptions(input) {
  return {
    dsn: input.dsn,
    release: input.release,
    enabled: input.enabled,
    integrations: (defaults) => buildServerIntegrations(defaults, input.cachePrefix),
    /* Какие корневые спаны становятся транзакциями — utils/traces-sampler.ts (чистая фабрика, покрыта юнитами). */
    tracesSampler: createTracesSampler({
      tracesSampleRate: input.tracesSampleRate,
      queueTracesSampleRate: input.queueTracesSampleRate,
      ignoredRoutes: input.ignoredRoutes
    }),
    tracePropagationTargets: [],
    dataCollection: DATA_COLLECTION,
    attachStacktrace: true,
    normalizeDepth: 8,
    enableRuntimeChannelInjection: false,
    beforeSend: serverBeforeSend,
    debug: false
  };
}
