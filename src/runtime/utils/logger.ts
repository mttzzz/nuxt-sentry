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
  captureException: (error: unknown, ctx: { tags: Record<string, string>; extra: Record<string, unknown> }) => void
  captureMessage: (
    message: string,
    ctx: { level: 'error'; tags: Record<string, string>; extra: Record<string, unknown> },
  ) => void
  addBreadcrumb: (breadcrumb: SentryBreadcrumb) => void
}

/*
 * Уровни (best-practice Sentry):
 *   debug → console-only, off в production (noise reduction)
 *   info  → console + Sentry breadcrumb (informational notice, не issue)
 *   warn  → console + Sentry breadcrumb (level=warning — контекст для error)
 *   error → console + captureException (Error в args) или captureMessage
 *
 * Breadcrumb попадает в Sentry только если в том же scope сработает error.
 */
export function createLoggerWithSink(tag: string, sink: LoggerSink): Logger {
  return {
    debug(message, ...args) {
      if (sink.isProduction) { return }
      sink.output('debug', tag, message, args)
    },
    info(message, ...args) {
      sink.output('info', tag, message, args)
      if (sink.isProduction) {
        sink.addBreadcrumb({ category: tag, message, level: 'info', data: args.length > 0 ? { args } : undefined })
      }
    },
    warn(message, ...args) {
      sink.output('warn', tag, message, args)
      if (sink.isProduction) {
        sink.addBreadcrumb({ category: tag, message, level: 'warning', data: args.length > 0 ? { args } : undefined })
      }
    },
    error(message, ...args) {
      sink.output('error', tag, message, args)
      if (!sink.isProduction) { return }
      const firstError = args.find((a): a is Error => a instanceof Error)
      const tags = { source: tag }
      if (firstError) {
        sink.captureException(firstError, { tags, extra: { message, args } })
      } else {
        sink.captureMessage(message, { level: 'error', tags, extra: { args } })
      }
    },
  }
}

const defaultSink: LoggerSink = {
  isProduction: process.env.NODE_ENV === 'production',
  output(level, tag, message, args) {
    /* oxlint-disable no-console -- logger is the only place that should use console */
    const dispatch = {
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
    } as const
    /* oxlint-enable no-console */
    dispatch[level](`[${tag}]`, message, ...args)
  },
  captureException(error, ctx) {
    Sentry.captureException(error, ctx)
  },
  captureMessage(message, ctx) {
    Sentry.captureMessage(message, ctx)
  },
  addBreadcrumb(breadcrumb) {
    Sentry.addBreadcrumb(breadcrumb)
  },
}

const loggerCache = new Map<string, Logger>()

export function createLogger(tag: string): Logger {
  const cached = loggerCache.get(tag)
  if (cached) { return cached }
  const logger = createLoggerWithSink(tag, defaultSink)
  loggerCache.set(tag, logger)
  return logger
}
