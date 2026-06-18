import * as Sentry from "@sentry/vue";
const loggerCache = /* @__PURE__ */ new Map();
export function createLogger(tag) {
  const cached = loggerCache.get(tag);
  if (cached) {
    return cached;
  }
  function emit(level, message, args) {
    Sentry.withScope((scope) => {
      scope.setTag("source", tag);
      scope.setExtras({ message, args });
      if (level === "error") {
        console.error(`[${tag}]`, message, ...args);
      } else {
        console.warn(`[${tag}]`, message, ...args);
      }
    });
  }
  const logger = {
    warn(message, ...args) {
      emit("warn", message, args);
    },
    error(message, ...args) {
      emit("error", message, args);
    }
  };
  loggerCache.set(tag, logger);
  return logger;
}
