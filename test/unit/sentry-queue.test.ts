import { beforeEach, describe, expect, it, vi } from 'vitest'

const startNewTraceMock = vi.fn(async (fn: () => Promise<unknown>) => fn())
type SpanCallback = (span: { setStatus: () => void }) => Promise<unknown>
const startSpanMock = vi.fn<[unknown, SpanCallback], Promise<unknown>>()
// oxlint-disable-next-line typescript/strict-void-return -- mock returns Promise where void expected; vitest mockImplementation typing limitation
startSpanMock.mockImplementation((_opts: unknown, fn: SpanCallback) => fn({ setStatus: vi.fn() }))
type TraceCallback = () => Promise<unknown>
const continueTraceMock = vi.fn<[unknown, TraceCallback], Promise<unknown>>()
continueTraceMock.mockImplementation((_ctx: unknown, fn: TraceCallback) => fn())
const captureExceptionMock = vi.fn()
const getTraceDataMock = vi.fn(() => ({ 'sentry-trace': 'abc-123', baggage: 'sentry-x=y' }))

vi.mock('@sentry/bun', () => ({
  startNewTrace: startNewTraceMock,
  startSpan: startSpanMock,
  continueTrace: continueTraceMock,
  captureException: captureExceptionMock,
  getTraceData: getTraceDataMock,
}))

const { instrumentQueueProducer, withSentryConsumer } = await import('../../src/runtime/utils/sentry-queue')

interface FakeQueue {
  name: string
  add: (...args: unknown[]) => Promise<unknown>
}

/* Wire-protocol fields used for queue tracing are prefixed with underscore by convention */
/* oxlint-disable no-underscore-dangle */
function makeFakeQueue(): FakeQueue & { _addCalls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    name: 'media',
    _addCalls: calls,
    add(...args: unknown[]) {
      calls.push(args)
      return Promise.resolve({ id: '42' })
    },
  }
}

describe('instrumentQueueProducer', () => {
  beforeEach(() => {
    startNewTraceMock.mockClear()
    startSpanMock.mockClear()
    getTraceDataMock.mockClear()
  })

  it('инжектит trace headers в job-data при default-style add(data, opts)', async () => {
    const queue = makeFakeQueue()
    instrumentQueueProducer(queue as never)

    await queue.add({ payload: 'x' }, { delay: 100 })

    expect(startNewTraceMock).toHaveBeenCalledOnce()
    const [data, opts] = queue._addCalls[0] as [Record<string, unknown>, unknown]
    expect(data).toMatchObject({
      payload: 'x',
      _sentryTrace: 'abc-123',
      _sentryBaggage: 'sentry-x=y',
    })
    expect(typeof data._sentryPublishedAt).toBe('number')
    expect(opts).toEqual({ delay: 100 })

    expect(startSpanMock).toHaveBeenCalledTimes(2)
    const outerSpanCall = startSpanMock.mock.calls[0] as [{ name: string }, unknown]
    const innerSpanCall = startSpanMock.mock.calls[1] as [{ op: string; name: string }, unknown]
    expect(outerSpanCall[0]).toEqual({ name: 'queue.publish/media' })
    expect(innerSpanCall[0]).toMatchObject({ op: 'queue.publish', name: 'media' })
  })

  it('инжектит trace headers при named-style add(name, data, opts)', async () => {
    const queue = makeFakeQueue()
    instrumentQueueProducer(queue as never)

    await queue.add('process-image', { id: 1 }, { attempts: 3 })

    const [name, data, opts] = queue._addCalls[0] as [string, Record<string, unknown>, unknown]
    expect(name).toBe('process-image')
    expect(data).toMatchObject({ id: 1, _sentryTrace: 'abc-123' })
    expect(opts).toEqual({ attempts: 3 })
  })
})
/* oxlint-enable no-underscore-dangle */

describe('withSentryConsumer', () => {
  beforeEach(() => {
    startNewTraceMock.mockClear()
    startSpanMock.mockClear()
    continueTraceMock.mockClear()
    captureExceptionMock.mockClear()
  })

  it('continueTrace когда есть _sentryTrace в job-data', async () => {
    const job = {
      id: 'job-1',
      data: { payload: 'x', _sentryTrace: 'abc', _sentryBaggage: 'b', _sentryPublishedAt: Date.now() - 100 },
      attemptsMade: 0,
    }
    const result = await withSentryConsumer('media', job as never, () => Promise.resolve('done'))

    expect(result).toBe('done')
    expect(continueTraceMock).toHaveBeenCalledOnce()
    const continueCall = continueTraceMock.mock.calls[0] as [unknown, unknown]
    expect(continueCall[0]).toEqual({ sentryTrace: 'abc', baggage: 'b' })
    expect(startNewTraceMock).not.toHaveBeenCalled()

    expect(startSpanMock).toHaveBeenCalledTimes(2)
    const outerCall = startSpanMock.mock.calls[0] as [{ name: string }, unknown]
    const innerCall = startSpanMock.mock.calls[1] as [{ op: string; name: string }, unknown]
    expect(outerCall[0]).toEqual({ name: 'queue.process/media' })
    expect(innerCall[0]).toMatchObject({ op: 'queue.process', name: 'media' })
  })

  it('startNewTrace когда _sentryTrace отсутствует', async () => {
    const job = { id: 'j', data: { payload: 'x' }, attemptsMade: 0 }
    await withSentryConsumer('media', job as never, () => Promise.resolve('ok'))
    expect(startNewTraceMock).toHaveBeenCalledOnce()
    expect(continueTraceMock).not.toHaveBeenCalled()
  })

  it('captureException + rethrow при ошибке fn', async () => {
    const job = { id: 'j', data: { payload: 'x' }, attemptsMade: 0 }
    const err = new Error('processing failed')
    await expect(withSentryConsumer('media', job as never, () => Promise.reject(err))).rejects.toThrow(
      'processing failed',
    )
    expect(captureExceptionMock).toHaveBeenCalledWith(err)
  })
})
