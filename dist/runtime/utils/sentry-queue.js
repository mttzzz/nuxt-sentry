import * as Sentry from "@sentry/bun";
export function instrumentQueueProducer(queue) {
  const originalAdd = queue.add.bind(queue);
  queue.add = (async (...args) => {
    const isNamed = typeof args[0] === "string";
    const jobType = isNamed ? args[0] : "default";
    const data = isNamed ? args[1] : args[0];
    const opts = isNamed ? args[2] : args[1];
    const bodySize = JSON.stringify(data).length;
    return Sentry.startNewTrace(
      async () => Sentry.startSpan(
        { name: `queue.publish/${queue.name}` },
        async () => Sentry.startSpan(
          {
            op: "queue.publish",
            name: queue.name,
            attributes: {
              "messaging.message.id": jobType,
              "messaging.destination.name": queue.name,
              "messaging.message.body.size": bodySize
            }
          },
          async () => {
            const traceData = Sentry.getTraceData();
            const enrichedData = {
              ...data,
              _sentryTrace: traceData?.["sentry-trace"],
              _sentryBaggage: traceData?.baggage,
              _sentryPublishedAt: Date.now()
            };
            return isNamed ? originalAdd(jobType, enrichedData, opts) : originalAdd(enrichedData, opts);
          }
        )
      )
    );
  });
  return queue;
}
export async function withSentryConsumer(queueName, job, fn) {
  const data = job.data;
  const { _sentryTrace, _sentryBaggage, _sentryPublishedAt } = data;
  const receiveLatency = _sentryPublishedAt ? Date.now() - _sentryPublishedAt : void 0;
  async function processJob() {
    return Sentry.startSpan(
      { name: `queue.process/${queueName}` },
      async (parentSpan) => Sentry.startSpan(
        {
          op: "queue.process",
          name: queueName,
          attributes: {
            "messaging.message.id": String(job.id),
            "messaging.destination.name": queueName,
            "messaging.message.body.size": JSON.stringify(job.data).length,
            "messaging.message.retry.count": job.attemptsMade,
            ...receiveLatency !== void 0 && { "messaging.message.receive.latency": receiveLatency }
          }
        },
        async () => {
          try {
            const result = await fn();
            parentSpan.setStatus({ code: 1, message: "ok" });
            return result;
          } catch (error) {
            parentSpan.setStatus({ code: 2, message: "error" });
            Sentry.captureException(error);
            throw error;
          }
        }
      )
    );
  }
  if (_sentryTrace) {
    return Sentry.continueTrace({ sentryTrace: _sentryTrace, baggage: _sentryBaggage }, processJob);
  }
  return Sentry.startNewTrace(processJob);
}
