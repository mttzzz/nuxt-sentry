import * as Sentry from '@sentry/vue'

export interface ClientLogger {
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

const loggerCache = new Map<string, ClientLogger>()

/*
 * Issues-first: warn/error пишутся в console внутри Sentry.withScope (source-тег + extra);
 * Issue заводит captureConsoleIntegration (см. plugin.client.ts) — единый канал, без дублей.
 */
export function createLogger(tag: string): ClientLogger {
  const cached = loggerCache.get(tag)
  if (cached) {
    return cached
  }

  function emit(level: 'warn' | 'error', message: string, args: unknown[]): void {
    Sentry.withScope((scope) => {
      scope.setTag('source', tag)
      scope.setExtras({ message, args })
      /* oxlint-disable no-console -- logger is the only place that should use console */
      if (level === 'error') {
        console.error(`[${tag}]`, message, ...args)
      } else {
        console.warn(`[${tag}]`, message, ...args)
      }
      /* oxlint-enable no-console */
    })
  }

  const logger: ClientLogger = {
    warn(message, ...args) {
      emit('warn', message, args)
    },
    error(message, ...args) {
      emit('error', message, args)
    },
  }

  loggerCache.set(tag, logger)
  return logger
}
