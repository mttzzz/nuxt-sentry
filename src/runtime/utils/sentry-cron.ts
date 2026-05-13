import * as Sentry from '@sentry/bun'

export interface CronMonitorOptions {
  checkinMargin?: number
  maxRuntime?: number
  timezone?: string
}

/*
 * Оборачивает Nitro scheduled task в Sentry Crons monitor.
 * Автоматически отправляет check-in (in_progress → ok/error).
 * Monitor создаётся в Sentry автоматически при первом вызове.
 */
export async function withCronMonitor<T>(
  slug: string,
  schedule: string,
  fn: () => Promise<T>,
  options?: CronMonitorOptions,
): Promise<T> {
  return Sentry.withMonitor(slug, fn, {
    schedule: { type: 'crontab', value: schedule },
    checkinMargin: options?.checkinMargin ?? 2,
    maxRuntime: options?.maxRuntime ?? 10,
    timezone: options?.timezone ?? 'Etc/UTC',
  })
}
