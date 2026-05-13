import * as Sentry from '@sentry/vue'

export interface ClientLogger {
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

const loggerCache = new Map<string, ClientLogger>()

export function createLogger(tag: string): ClientLogger {
  const cached = loggerCache.get(tag)
  if (cached) {
    return cached
  }

  /* oxlint-disable no-console -- logger is the only place that should use console */
  const logger: ClientLogger = {
    warn(message, ...args) {
      console.warn(`[${tag}]`, message, ...args)
      Sentry.addBreadcrumb({
        category: tag,
        message,
        level: 'warning',
        data: args.length > 0 ? { args } : undefined,
      })
    },
    error(message, ...args) {
      console.error(`[${tag}]`, message, ...args)
      const firstError = args.find((a): a is Error => a instanceof Error)
      const err = firstError ?? new Error(message)
      Sentry.captureException(err, { tags: { source: tag } })
    },
  }
  /* oxlint-enable no-console */

  loggerCache.set(tag, logger)
  return logger
}
