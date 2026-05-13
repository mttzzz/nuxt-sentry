import * as Sentry from "@sentry/bun";
export async function withCronMonitor(slug, schedule, fn, options) {
  return Sentry.withMonitor(slug, fn, {
    schedule: { type: "crontab", value: schedule },
    checkinMargin: options?.checkinMargin ?? 2,
    maxRuntime: options?.maxRuntime ?? 10,
    timezone: options?.timezone ?? "Etc/UTC"
  });
}
