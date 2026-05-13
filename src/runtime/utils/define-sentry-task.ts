import * as Sentry from '@sentry/bun'
import { defineTask } from 'nitropack/runtime'

import { type Logger, createLogger } from './logger'

export interface SentryTaskMeta {
  name: string
  description: string
  /* Cron-расписание для Sentry Crons monitor (auto-alert если task не запустился). */
  cron?: string
}

export interface SentryTaskOutcome {
  result: 'success' | 'error'
  message?: string
  [key: string]: unknown
}

interface SentryRuntime {
  startNewTrace: (fn: () => Promise<unknown>) => Promise<unknown>
  startSpan: (
    opts: { op: string; name: string; attributes?: Record<string, unknown> },
    fn: () => Promise<unknown>,
  ) => Promise<unknown>
  withMonitor: (slug: string, fn: () => Promise<unknown>, monitorConfig: unknown) => Promise<unknown>
}

interface LoggerSurface {
  error: (msg: string, ...args: unknown[]) => void
}

interface RunBodyArgs<R extends Record<string, unknown>> {
  meta: { name: string; cron?: string }
  run: () => Promise<R>
  logger: LoggerSurface
  sentry: SentryRuntime
}

/*
 * Pure execution body — testable без Nitro/Sentry SDK.
 *
 * Sentry-обвязка:
 *   1. startNewTrace — новый trace на каждый запуск
 *   2. startSpan op=task — длительность в Performance
 *   3. withMonitor (если есть cron) — Sentry Crons check-in alert
 *
 * Error path: catch → logger.error (наш sink уходит в Sentry с тегом
 * source=task:<name>) → возвращаем { result: error, message }. Никогда не
 * пробрасываем — Nitro task runner не интегрирован с error-hook'ом.
 */
export async function runSentryTaskBody<R extends Record<string, unknown>>({
  meta,
  run,
  logger,
  sentry,
}: RunBodyArgs<R>): Promise<SentryTaskOutcome> {
  async function body(): Promise<SentryTaskOutcome> {
    return sentry.startSpan({ op: 'task', name: meta.name, attributes: { 'task.name': meta.name } }, async () => {
      try {
        const data = await run()
        return { result: 'success', ...data }
      } catch (error: unknown) {
        logger.error(`Task ${meta.name} failed`, error)
        return {
          result: 'error',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }) as Promise<SentryTaskOutcome>
  }

  if (meta.cron) {
    return sentry.withMonitor(meta.name, () => sentry.startNewTrace(body), {
      schedule: { type: 'crontab', value: meta.cron },
      checkinMargin: 2,
      maxRuntime: 10,
      timezone: 'Etc/UTC',
    }) as Promise<SentryTaskOutcome>
  }
  return sentry.startNewTrace(body) as Promise<SentryTaskOutcome>
}

const defaultSentry: SentryRuntime = {
  startNewTrace: (fn) => Sentry.startNewTrace(fn),
  startSpan: (opts, fn) => Sentry.startSpan(opts as never, fn),
  withMonitor: (slug, fn, config) => Sentry.withMonitor(slug, fn, config as never),
}

/*
 * Обёртка над Nitro defineTask. defineTask импортится явно из 'nitropack/runtime'
 * (тот же путь, что pkg уже использует для defineNitroPlugin в plugin-capture-errors).
 * Logger автоматически создан с тегом `task:<meta.name>` и приходит первым аргументом в run.
 */
export function defineSentryTask<R extends Record<string, unknown>>(opts: {
  meta: SentryTaskMeta
  run: (ctx: { logger: Logger }) => Promise<R>
}) {
  const { name, description, cron } = opts.meta
  const logger = createLogger(`task:${name}`)
  return defineTask({
    meta: { name, description },
    async run() {
      return runSentryTaskBody({
        meta: { name, cron },
        run: () => opts.run({ logger }),
        logger,
        sentry: defaultSentry,
      })
    },
  })
}
