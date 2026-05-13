import * as Sentry from "@sentry/vue";
const loggerCache = /* @__PURE__ */ new Map();
export function createLogger(tag) {
  const cached = loggerCache.get(tag);
  if (cached) {
    return cached;
  }
  const logger = {
    warn(message, ...args) {
      console.warn(`[${tag}]`, message, ...args);
      Sentry.addBreadcrumb({
        category: tag,
        message,
        level: "warning",
        data: args.length > 0 ? { args } : void 0
      });
    },
    error(message, ...args) {
      console.error(`[${tag}]`, message, ...args);
      const firstError = args.find((a) => a instanceof Error);
      const err = firstError ?? new Error(message);
      Sentry.captureException(err, { tags: { source: tag } });
    }
  };
  loggerCache.set(tag, logger);
  return logger;
}
