import * as Sentry from '@sentry/bun'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

export interface SentryBreadcrumb {
  category: string
  message: string
  level: 'info' | 'warning'
  data?: Record<string, unknown>
}

export interface LoggerSink {
  isProduction: boolean
  output: (level: LogLevel, tag: string, message: string, args: unknown[]) => void
  /* Для warn/error в prod обогащает Sentry-scope (source-тег + extra) на время write().
   * captureConsoleIntegration ловит console.* внутри этого scope → Issue с контекстом. */
  withSourceScope: (tag: string, extra: Record<string, unknown>, write: () => void) => void
  addBreadcrumb: (breadcrumb: SentryBreadcrumb) => void
}

/*
 * Issues-first (см. docs/specs/2026-06-18-issues-first-observability-design.md):
 *   debug → console-only, off в prod
 *   info  → console + breadcrumb(level=info) — контекст, НЕ Issue
 *   warn  → console.warn внутри withSourceScope → Issue(level=warning) через captureConsole
 *   error → console.error внутри withSourceScope → Issue(level=error) через captureConsole
 * Capture неявный (captureConsoleIntegration) — logger НЕ зовёт captureException (анти-дубль).
 */
export function createLoggerWithSink(tag: string, sink: LoggerSink): Logger {
  return {
    debug(message, ...args) {
      if (sink.isProduction) {
        return
      }
      sink.output('debug', tag, message, args)
    },
    info(message, ...args) {
      sink.output('info', tag, message, args)
      if (sink.isProduction) {
        sink.addBreadcrumb({ category: tag, message, level: 'info', data: args.length > 0 ? { args } : undefined })
      }
    },
    warn(message, ...args) {
      if (sink.isProduction) {
        sink.withSourceScope(tag, { message, args }, () => {
          sink.output('warn', tag, message, args)
        })
      } else {
        sink.output('warn', tag, message, args)
      }
    },
    error(message, ...args) {
      if (sink.isProduction) {
        sink.withSourceScope(tag, { message, args }, () => {
          sink.output('error', tag, message, args)
        })
      } else {
        sink.output('error', tag, message, args)
      }
    },
  }
}

const defaultSink: LoggerSink = {
  isProduction: process.env.NODE_ENV === 'production',
  output(level, tag, message, args) {
    /* oxlint-disable no-console -- logger is the only place that should use console */
    const dispatch = { error: console.error, warn: console.warn, info: console.info, debug: console.debug } as const
    /* oxlint-enable no-console */
    dispatch[level](`[${tag}]`, message, ...args)
  },
  withSourceScope(tag, extra, write) {
    Sentry.withScope((scope) => {
      scope.setTag('source', tag)
      scope.setExtras(extra)
      write()
    })
  },
  addBreadcrumb(breadcrumb) {
    Sentry.addBreadcrumb(breadcrumb)
  },
}

const loggerCache = new Map<string, Logger>()

export function createLogger(tag: string): Logger {
  const cached = loggerCache.get(tag)
  if (cached) {
    return cached
  }
  const logger = createLoggerWithSink(tag, defaultSink)
  loggerCache.set(tag, logger)
  return logger
}
