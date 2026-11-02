/*
 * Опыт «ловушка DSN + OTel-спан» для server-otel-event-trace.test.ts: настоящий `Sentry.init`, настоящий Bun.serve,
 * приёмник конвертов вместо Sentry и настоящий OpenTelemetry — как у ядра (chassis): AsyncLocalStorageContextManager и
 * SDK-провайдер спанов. Запрос ловит события внутри OTel-спана и вне него, с входящим `sentry-trace` браузера и без
 * него. Печатает JSON-сводку в stdout.
 *
 * Режим — первый аргумент:
 *   module   — опции модуля (buildServerSentryOptions), как в instrument.server.ts;
 *   defaults — дефолтные интеграции SDK и одна наша: опции модуля не нужны;
 *   bare     — `defaultIntegrations: false` и одна наша, как chassis `initSentry` у сервисов (нет и спана http.server).
 *
 * Запускается ПОД BUN отдельным процессом: Sentry.init патчит Bun.serve и globalThis.fetch на весь процесс, менеджер
 * контекста OTel — глобальный, и в воркере vitest этого делать нельзя. Приёмник создаётся ДО init — его Bun.serve
 * не инструментируется. OTel регистрируется ПОСЛЕ init, как в ядре: Sentry стартует из instrument-чанка первым.
 */
import { context, INVALID_SPAN_CONTEXT, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { TracerProvider } from '@opentelemetry/sdk-trace'
import * as Sentry from '@sentry/bun'

import { buildServerSentryOptions } from '../../../src/runtime/utils/server-init-options'

interface SpanIds {
  traceId: string
  spanId: string
}

interface Summary {
  mode: string
  /* trace_id и id спана, которые прислал «браузер» в заголовке sentry-trace. */
  browser: SpanIds
  integrations: string[]
  /* Что видел обработчик запроса: активный OTel-спан (если он создан) и активный спан самого Sentry (http.server). */
  cases: Record<string, { otel?: SpanIds; sentry?: SpanIds }>
  events: {
    message?: string
    exceptionValue?: string
    mechanism?: string
    trace?: Record<string, unknown>
  }[]
}

interface EventPayload {
  message?: string
  exception?: { values?: { value?: string; mechanism?: { type?: string } }[] }
  contexts?: { trace?: Record<string, unknown> }
}

const mode = process.argv[2] ?? 'module'

const trapItems: { type: string; payload: unknown }[] = []
const trap = Bun.serve({
  port: 0,
  async fetch(request) {
    const lines = (await request.text()).split('\n').filter(Boolean)
    for (let index = 1; index < lines.length; index += 2) {
      const header = JSON.parse(lines[index] ?? '{}') as { type: string }
      trapItems.push({ type: header.type, payload: JSON.parse(lines[index + 1] ?? 'null') as unknown })
    }
    return new Response('{}')
  },
})

const dsn = `http://key@127.0.0.1:${String(trap.port)}/1`
if (mode === 'module') {
  Sentry.init({
    ...buildServerSentryOptions({
      dsn,
      release: 'otel-trace-test',
      enabled: true,
      cachePrefix: 'otel-trace:',
      tracesSampleRate: 0,
      queueTracesSampleRate: 0,
      ignoredRoutes: [],
    }),
  })
} else if (mode === 'defaults') {
  /* Динамический импорт: режим `module` не зависит от файла интеграции (красный/зелёный прогон на старых исходниках). */
  const { otelEventTraceIntegration } = await import('../../../src/runtime/utils/otel-event-trace')
  Sentry.init({
    dsn,
    release: 'otel-trace-test',
    tracesSampleRate: 0,
    integrations: (defaults) => [...defaults, otelEventTraceIntegration()],
  })
} else if (mode === 'bare') {
  const { otelEventTraceIntegration } = await import('../../../src/runtime/utils/otel-event-trace')
  Sentry.init({
    dsn,
    release: 'otel-trace-test',
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [otelEventTraceIntegration()],
  })
} else {
  throw new Error(`unknown mode: ${mode}`)
}

const client = Sentry.getClient()
if (!client) {
  throw new Error('Sentry client was not created')
}

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
trace.setGlobalTracerProvider(new TracerProvider())
const tracer = trace.getTracer('otel-event-trace-test')

function toIds(spanContext: { traceId: string; spanId: string } | undefined): SpanIds | undefined {
  return spanContext === undefined ? undefined : { traceId: spanContext.traceId, spanId: spanContext.spanId }
}

/* Пути захвата, которыми ядро шлёт события: captureMessage, captureException, console.error (issues-first). */
function captureAll(label: string): void {
  Sentry.captureMessage(`${label}:message`, 'error')
  Sentry.captureException(new Error(`${label}:exception`))
  console.error(`${label}:console`)
}

const cases: Summary['cases'] = {}

const app = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    const label = url.searchParams.get('case') ?? 'unknown'
    const seen: Summary['cases'][string] = { sentry: toIds(Sentry.getActiveSpan()?.spanContext()) }
    cases[label] = seen
    if (url.pathname === '/inside') {
      /* Как withRequestSpan ядра: корневой спан запроса, активный на время обработки. */
      tracer.startActiveSpan('chassis request', (span) => {
        seen.otel = toIds(span.spanContext())
        captureAll(label)
        span.end()
      })
    } else if (url.pathname === '/invalid') {
      /* Активный OTel-спан с невалидным контекстом (нули): трогать событие не из-за чего. */
      context.with(trace.setSpan(context.active(), trace.wrapSpanContext(INVALID_SPAN_CONTEXT)), () => {
        captureAll(label)
      })
    } else {
      captureAll(label)
    }
    return new Response('ok')
  },
})

const browser: SpanIds = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
const browserHeaders = {
  'sentry-trace': `${browser.traceId}-${browser.spanId}-0`,
  baggage: `sentry-trace_id=${browser.traceId},sentry-sampled=false`,
}
const base = `http://127.0.0.1:${String(app.port)}`
await (await fetch(`${base}/inside?case=inside-with`, { headers: browserHeaders })).text()
await (await fetch(`${base}/inside?case=inside-without`)).text()
await (await fetch(`${base}/outside?case=outside-with`, { headers: browserHeaders })).text()
await (await fetch(`${base}/outside?case=outside-without`)).text()
await (await fetch(`${base}/invalid?case=invalid-with`, { headers: browserHeaders })).text()

await Sentry.flush(3000)
/* Окно для транспорта: события уходят отдельными конвертами. */
await Bun.sleep(300)
await Sentry.flush(3000)

const summary: Summary = {
  mode,
  browser,
  integrations: client.getIntegrationNames(),
  cases,
  events: trapItems
    .filter((item) => item.type === 'event')
    .map(({ payload }) => {
      const event = payload as EventPayload
      const entry = event.exception?.values?.[0]
      return {
        message: event.message,
        exceptionValue: entry?.value,
        mechanism: entry?.mechanism?.type,
        trace: event.contexts?.trace,
      }
    }),
}
process.stdout.write(`${JSON.stringify(summary)}\n`)

app.stop(true)
trap.stop(true)
process.exit(0)
