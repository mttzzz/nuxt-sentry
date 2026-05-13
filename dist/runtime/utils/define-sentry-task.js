import * as Sentry from "@sentry/bun";
import { defineTask } from "nitropack/runtime";
import { createLogger } from "./logger.js";
export async function runSentryTaskBody({
  meta,
  run,
  logger,
  sentry
}) {
  async function body() {
    return sentry.startSpan({ op: "task", name: meta.name, attributes: { "task.name": meta.name } }, async () => {
      try {
        const data = await run();
        return { result: "success", ...data };
      } catch (error) {
        logger.error(`Task ${meta.name} failed`, error);
        return {
          result: "error",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    });
  }
  if (meta.cron) {
    return sentry.withMonitor(meta.name, () => sentry.startNewTrace(body), {
      schedule: { type: "crontab", value: meta.cron },
      checkinMargin: 2,
      maxRuntime: 10,
      timezone: "Etc/UTC"
    });
  }
  return sentry.startNewTrace(body);
}
const defaultSentry = {
  startNewTrace: (fn) => Sentry.startNewTrace(fn),
  startSpan: (opts, fn) => Sentry.startSpan(opts, fn),
  withMonitor: (slug, fn, config) => Sentry.withMonitor(slug, fn, config)
};
export function defineSentryTask(opts) {
  const { name, description, cron } = opts.meta;
  const logger = createLogger(`task:${name}`);
  return defineTask({
    meta: { name, description },
    async run() {
      return runSentryTaskBody({
        meta: { name, cron },
        run: () => opts.run({ logger }),
        logger,
        sentry: defaultSentry
      });
    }
  });
}
