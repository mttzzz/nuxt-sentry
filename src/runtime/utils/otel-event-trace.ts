import { trace } from '@opentelemetry/api'
import type { Event, Integration } from '@sentry/core'

/*
 * Корреляция trace_id серверных событий со спанами OpenTelemetry.
 *
 * Серверный код проекта (ai.pushka.biz: packages/chassis, `withRequestSpan` и спаны заданий pg-boss) ведёт СВОИ
 * OTel-спаны и кладёт их в контекст через @opentelemetry/api. Событие Sentry, пойманное внутри такого спана, обязано
 * нести его trace_id и span_id: по ним issue находится в хранилище трейсов, а трейс — из issue.
 *
 * На 10.x это делал `setupEventContextTrace` из @sentry/opentelemetry: на `preprocessEvent` активный OTel-спан
 * становился `contexts.trace` события. На 11 пакета в цепочке нет: `prepareEvent` берёт `contexts.trace` из активного
 * спана САМОГО Sentry (http.server-спан Bun.serve; @sentry/core, utils/scopeData.js → applySpanToEvent), а в
 * `_prepareEvent` (client.js) контекст, уже лежащий на событии, перекрывает вычисленный из scope. Итог без интеграции:
 * событие внутри OTel-спана получало trace_id браузера (входящий `sentry-trace`) или http.server-спана Sentry, а не
 * спана chassis. `Sentry.openTelemetryIntegration()` этого не меняет — тот же приоритет.
 *
 * Точка — `preprocessEvent`, до `prepareEvent`: контекст, уже лежащий на событии, имеет приоритет и над
 * `applySpanToEvent`, и над scope. `processEvent`/`postprocessEvent` (после) тоже подменяют trace_id и span_id, но
 * оставляют от http.server-спана чужой `parent_span_id` (при входящем `sentry-trace` — id спана браузера): у спана
 * chassis появляется родитель, которого у него нет (проверено опытом на 11.10.0, Bun 1.4.2 и 1.4.4). Отсутствие чужого
 * `parent_span_id` у события в спане проверяет строка (а) test/unit/server-otel-event-trace.test.ts.
 *
 * Вне спана (нет менеджера контекста, нет активного спана, невалидный контекст) событие не трогаем: trace_id остаётся
 * таким, каким его даёт Sentry (браузера при `sentry-trace`, иначе http.server-спана). Транзакции — тоже: у них
 * свой контекст и свой span_id, подмена сломала бы дерево спанов.
 *
 * `@opentelemetry/api` — peerDependency модуля: активный спан читается из глобального реестра API, а из реестра читает
 * только та копия, чей minor не новее minor копии-регистратора (её ставит менеджер контекста ядра). Более новая копия
 * увидела бы пустой контекст — событие молча осталось бы на trace Sentry. Поэтому копия одна, та же, что у ядра.
 */
function applyActiveOtelSpan(event: Event): void {
  if (event.type === 'transaction') {
    return
  }
  const spanContext = trace.getActiveSpan()?.spanContext()
  if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) {
    return
  }
  event.contexts = {
    ...event.contexts,
    trace: { ...event.contexts?.trace, trace_id: spanContext.traceId, span_id: spanContext.spanId },
  }
}

export function otelEventTraceIntegration(): Integration {
  return {
    name: 'OtelEventTrace',
    setup(client) {
      client.on('preprocessEvent', applyActiveOtelSpan)
    },
  }
}
