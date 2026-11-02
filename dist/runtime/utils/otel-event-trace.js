import { trace } from "@opentelemetry/api";
function applyActiveOtelSpan(event) {
  if (event.type === "transaction") {
    return;
  }
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext === void 0 || !trace.isSpanContextValid(spanContext)) {
    return;
  }
  event.contexts = {
    ...event.contexts,
    trace: { ...event.contexts?.trace, trace_id: spanContext.traceId, span_id: spanContext.spanId }
  };
}
export function otelEventTraceIntegration() {
  return {
    name: "OtelEventTrace",
    setup(client) {
      client.on("preprocessEvent", applyActiveOtelSpan);
    }
  };
}
