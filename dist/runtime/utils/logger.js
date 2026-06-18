import * as Sentry from "@sentry/bun";
export function createLoggerWithSink(tag, sink) {
  return {
    debug(message, ...args) {
      if (sink.isProduction) {
        return;
      }
      sink.output("debug", tag, message, args);
    },
    info(message, ...args) {
      sink.output("info", tag, message, args);
      if (sink.isProduction) {
        sink.addBreadcrumb({ category: tag, message, level: "info", data: args.length > 0 ? { args } : void 0 });
      }
    },
    warn(message, ...args) {
      if (sink.isProduction) {
        sink.withSourceScope(tag, { message, args }, () => {
          sink.output("warn", tag, message, args);
        });
      } else {
        sink.output("warn", tag, message, args);
      }
    },
    error(message, ...args) {
      if (sink.isProduction) {
        sink.withSourceScope(tag, { message, args }, () => {
          sink.output("error", tag, message, args);
        });
      } else {
        sink.output("error", tag, message, args);
      }
    }
  };
}
const defaultSink = {
  isProduction: process.env.NODE_ENV === "production",
  output(level, tag, message, args) {
    const dispatch = { error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    dispatch[level](`[${tag}]`, message, ...args);
  },
  withSourceScope(tag, extra, write) {
    Sentry.withScope((scope) => {
      scope.setTag("source", tag);
      scope.setExtras(extra);
      write();
    });
  },
  addBreadcrumb(breadcrumb) {
    Sentry.addBreadcrumb(breadcrumb);
  }
};
const loggerCache = /* @__PURE__ */ new Map();
export function createLogger(tag) {
  const cached = loggerCache.get(tag);
  if (cached) {
    return cached;
  }
  const logger = createLoggerWithSink(tag, defaultSink);
  loggerCache.set(tag, logger);
  return logger;
}
