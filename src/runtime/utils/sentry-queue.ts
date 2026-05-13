/*
 * Sentry Queue Monitoring — инструментация Bull queues.
 *
 * Два механизма:
 * 1. instrumentQueueProducer(queue) — monkey-patch .add() для автоматического
 *    создания queue.publish спанов и инъекции trace headers в job data.
 * 2. withSentryConsumer(queueName, job, fn) — обёртка для consumer callback,
 *    создаёт queue.process спан и продолжает trace от producer.
 *
 * Поля _sentryTrace / _sentryBaggage / _sentryPublishedAt — wire-protocol поля
 * (не приватные), передаются как часть job data через Bull queue.
 *
 * @see https://docs.sentry.io/platforms/javascript/guides/node/tracing/instrumentation/custom-instrumentation/queues-module/
 */
import * as Sentry from '@sentry/bun'
import type Queue from 'bull'

interface SentryQueueMeta {
  _sentryTrace?: string
  _sentryBaggage?: string
  _sentryPublishedAt?: number
}

export function instrumentQueueProducer<T>(queue: Queue.Queue<T>): Queue.Queue<T> {
  const originalAdd = queue.add.bind(queue) as (
    ...args: [string, unknown, Queue.JobOptions?] | [unknown, Queue.JobOptions?]
  ) => Promise<Queue.Job<T>>

  queue.add = (async (...args: unknown[]) => {
    const isNamed = typeof args[0] === 'string'
    const jobType = isNamed ? (args[0] as string) : 'default'
    const data = (isNamed ? args[1] : args[0]) as Record<string, unknown>
    const opts = (isNamed ? args[2] : args[1]) as Queue.JobOptions | undefined
    const bodySize = JSON.stringify(data).length

    return Sentry.startNewTrace(async () =>
      Sentry.startSpan({ name: `queue.publish/${queue.name}` }, async () =>
        Sentry.startSpan(
          {
            op: 'queue.publish',
            name: queue.name,
            attributes: {
              'messaging.message.id': jobType,
              'messaging.destination.name': queue.name,
              'messaging.message.body.size': bodySize,
            },
          },
          async () => {
            const traceData = Sentry.getTraceData()
            const enrichedData: Record<string, unknown> = {
              ...data,
              _sentryTrace: traceData?.['sentry-trace'],
              _sentryBaggage: traceData?.baggage,
              _sentryPublishedAt: Date.now(),
            }
            return isNamed ? originalAdd(jobType, enrichedData, opts) : originalAdd(enrichedData, opts)
          },
        ),
      ),
    )
  }) as typeof queue.add

  return queue
}

export async function withSentryConsumer<T, R>(queueName: string, job: Queue.Job<T>, fn: () => Promise<R>): Promise<R> {
  const data = job.data as T & SentryQueueMeta
  const { _sentryTrace, _sentryBaggage, _sentryPublishedAt } = data
  const receiveLatency = _sentryPublishedAt ? Date.now() - _sentryPublishedAt : undefined

  async function processJob() {
    return Sentry.startSpan({ name: `queue.process/${queueName}` }, async (parentSpan) =>
      Sentry.startSpan(
        {
          op: 'queue.process',
          name: queueName,
          attributes: {
            'messaging.message.id': String(job.id),
            'messaging.destination.name': queueName,
            'messaging.message.body.size': JSON.stringify(job.data).length,
            'messaging.message.retry.count': job.attemptsMade,
            ...(receiveLatency !== undefined && { 'messaging.message.receive.latency': receiveLatency }),
          },
        },
        async () => {
          try {
            const result = await fn()
            parentSpan.setStatus({ code: 1, message: 'ok' })
            return result
          } catch (error) {
            parentSpan.setStatus({ code: 2, message: 'error' })
            Sentry.captureException(error)
            throw error
          }
        },
      ),
    )
  }

  if (_sentryTrace) {
    return Sentry.continueTrace({ sentryTrace: _sentryTrace, baggage: _sentryBaggage }, processJob)
  }
  return Sentry.startNewTrace(processJob)
}
