const INFRASTRUCTURE_OP = /^(?:db|cache)(?:\.|$)/u;
const QUEUE_SPAN_PREFIXES = ["queue.publish/", "queue.process/"];
const HTTP_METHOD_PREFIX = /^[A-Z]+ /u;
export function createTracesSampler(options) {
  const { tracesSampleRate, queueTracesSampleRate, ignoredRoutes } = options;
  return ({ name, attributes }) => {
    const op = attributes?.["sentry.op"];
    if (typeof op === "string" && INFRASTRUCTURE_OP.test(op)) {
      return 0;
    }
    if (name !== void 0 && QUEUE_SPAN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return queueTracesSampleRate;
    }
    const urlPath = attributes?.["url.path"];
    const path = typeof urlPath === "string" ? urlPath : name?.replace(HTTP_METHOD_PREFIX, "");
    if (path !== void 0 && ignoredRoutes.some((route) => path.startsWith(route))) {
      return 0;
    }
    return tracesSampleRate;
  };
}
