import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createLoggerWithSink, type LoggerSink } from '../../src/runtime/utils/logger'

function makeSink(overrides: Partial<LoggerSink> = {}): LoggerSink {
  return {
    isProduction: false,
    output: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    ...overrides,
  }
}

describe('createLoggerWithSink', () => {
  describe('debug', () => {
    it('пишет в output в dev', () => {
      const sink = makeSink({ isProduction: false })
      const log = createLoggerWithSink('test', sink)
      log.debug('hello', 1, 2)
      expect(sink.output).toHaveBeenCalledWith('debug', 'test', 'hello', [1, 2])
    })

    it('НЕ пишет в production (noise reduction)', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('test', sink)
      log.debug('hello')
      expect(sink.output).not.toHaveBeenCalled()
    })
  })

  describe('info', () => {
    it('пишет в output всегда', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('test', sink)
      log.info('hello', { foo: 1 })
      expect(sink.output).toHaveBeenCalledWith('info', 'test', 'hello', [{ foo: 1 }])
    })

    it('добавляет breadcrumb (level=info) в production', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('amo', sink)
      log.info('synced', { count: 5 })
      expect(sink.addBreadcrumb).toHaveBeenCalledWith({
        category: 'amo',
        message: 'synced',
        level: 'info',
        data: { args: [{ count: 5 }] },
      })
    })

    it('НЕ добавляет breadcrumb в dev', () => {
      const sink = makeSink({ isProduction: false })
      const log = createLoggerWithSink('amo', sink)
      log.info('synced')
      expect(sink.addBreadcrumb).not.toHaveBeenCalled()
    })
  })

  describe('warn', () => {
    it('пишет в output + breadcrumb (level=warning) в production', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('redis', sink)
      log.warn('connection refused')
      expect(sink.output).toHaveBeenCalledWith('warn', 'redis', 'connection refused', [])
      expect(sink.addBreadcrumb).toHaveBeenCalledWith({
        category: 'redis',
        message: 'connection refused',
        level: 'warning',
        data: undefined,
      })
    })
  })

  describe('error', () => {
    it('captureException когда есть Error в args (с тегом source)', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('worker', sink)
      const err = new Error('boom')
      log.error('processing failed', err)
      expect(sink.captureException).toHaveBeenCalledWith(err, {
        tags: { source: 'worker' },
        extra: { message: 'processing failed', args: [err] },
      })
      expect(sink.captureMessage).not.toHaveBeenCalled()
    })

    it('captureMessage (level=error) когда нет Error в args', () => {
      const sink = makeSink({ isProduction: true })
      const log = createLoggerWithSink('worker', sink)
      log.error('something bad', { foo: 1 })
      expect(sink.captureMessage).toHaveBeenCalledWith('something bad', {
        level: 'error',
        tags: { source: 'worker' },
        extra: { args: [{ foo: 1 }] },
      })
      expect(sink.captureException).not.toHaveBeenCalled()
    })

    it('пишет в output всегда', () => {
      const sink = makeSink({ isProduction: false })
      const log = createLoggerWithSink('worker', sink)
      log.error('msg')
      expect(sink.output).toHaveBeenCalledWith('error', 'worker', 'msg', [])
    })

    it('НЕ шлёт в Sentry в dev', () => {
      const sink = makeSink({ isProduction: false })
      const log = createLoggerWithSink('worker', sink)
      log.error('msg', new Error('x'))
      expect(sink.captureException).not.toHaveBeenCalled()
      expect(sink.captureMessage).not.toHaveBeenCalled()
    })
  })
})
