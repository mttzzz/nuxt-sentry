import { describe, expect, it, vi } from 'vitest'

import { createLogger, createLoggerWithSink, type LoggerSink } from '../../src/runtime/utils/logger'

function makeSink(overrides: Partial<LoggerSink> = {}): LoggerSink {
  return {
    isProduction: false,
    output: vi.fn<LoggerSink['output']>(),
    /* Мок: withSourceScope сразу вызывает write() — так тест видит и факт обогащения, и output */
    withSourceScope: vi.fn<LoggerSink['withSourceScope']>((_tag, _extra, write) => {
      write()
    }),
    addBreadcrumb: vi.fn<LoggerSink['addBreadcrumb']>(),
    ...overrides,
  }
}

describe('createLoggerWithSink', () => {
  describe('debug', () => {
    it('output в dev, тишина в prod', () => {
      const dev = makeSink({ isProduction: false })
      createLoggerWithSink('t', dev).debug('hi', 1)
      expect(dev.output).toHaveBeenCalledWith('debug', 't', 'hi', [1])

      const prod = makeSink({ isProduction: true })
      createLoggerWithSink('t', prod).debug('hi')
      expect(prod.output).not.toHaveBeenCalled()
    })
  })

  describe('info', () => {
    it('output всегда + breadcrumb(level=info) в prod, без withSourceScope', () => {
      const sink = makeSink({ isProduction: true })
      createLoggerWithSink('amo', sink).info('synced', { count: 5 })
      expect(sink.output).toHaveBeenCalledWith('info', 'amo', 'synced', [{ count: 5 }])
      expect(sink.addBreadcrumb).toHaveBeenCalledWith({
        category: 'amo',
        message: 'synced',
        level: 'info',
        data: { args: [{ count: 5 }] },
      })
      expect(sink.withSourceScope).not.toHaveBeenCalled()
    })
  })

  describe('warn', () => {
    it('prod: output обёрнут в withSourceScope(source, extra) — даёт Issue через captureConsole', () => {
      const sink = makeSink({ isProduction: true })
      createLoggerWithSink('redis', sink).warn('connection refused', { attempt: 2 })
      expect(sink.withSourceScope).toHaveBeenCalledWith(
        'redis',
        { message: 'connection refused', args: [{ attempt: 2 }] },
        expect.any(Function),
      )
      expect(sink.output).toHaveBeenCalledWith('warn', 'redis', 'connection refused', [{ attempt: 2 }])
    })

    it('dev: только output, без withSourceScope', () => {
      const sink = makeSink({ isProduction: false })
      createLoggerWithSink('redis', sink).warn('x')
      expect(sink.output).toHaveBeenCalledWith('warn', 'redis', 'x', [])
      expect(sink.withSourceScope).not.toHaveBeenCalled()
    })
  })

  describe('error', () => {
    it('prod: output обёрнут в withSourceScope(source, extra)', () => {
      const sink = makeSink({ isProduction: true })
      const err = new Error('boom')
      createLoggerWithSink('worker', sink).error('failed', err)
      expect(sink.withSourceScope).toHaveBeenCalledWith(
        'worker',
        { message: 'failed', args: [err] },
        expect.any(Function),
      )
      expect(sink.output).toHaveBeenCalledWith('error', 'worker', 'failed', [err])
    })

    it('dev: только output, без withSourceScope', () => {
      const sink = makeSink({ isProduction: false })
      createLoggerWithSink('worker', sink).error('msg', new Error('x'))
      expect(sink.output).toHaveBeenCalledWith('error', 'worker', 'msg', [new Error('x')])
      expect(sink.withSourceScope).not.toHaveBeenCalled()
    })
  })
})

describe('createLogger cache', () => {
  it('один инстанс на тег', () => {
    expect(createLogger('cache-test')).toBe(createLogger('cache-test'))
  })
})
