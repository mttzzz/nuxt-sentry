import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

/*
 * Опыт: trace_id серверного события внутри OTel-спана, как в server-sentry-traffic.test.ts: фикстура
 * server-otel-trace.ts поднимает настоящий `Sentry.init` с опциями модуля (buildServerSentryOptions), Bun.serve,
 * приёмник конвертов (ловушку DSN) и настоящий OpenTelemetry — как у chassis ядра: AsyncLocalStorageContextManager и
 * SDK-провайдер, спан через `trace.getTracer().startActiveSpan`. Под Bun отдельным процессом: init патчит Bun.serve и
 * globalThis.fetch на весь процесс, менеджер контекста OTel — глобальный.
 *
 * На 10.x событие внутри активного OTel-спана несло его trace_id и span_id (setupEventContextTrace из
 * @sentry/opentelemetry); на 11 без интеграции OtelEventTrace — trace браузера (входящий `sentry-trace`) или
 * http.server-спана Sentry. Источник trace_id события:
 *
 *   сценарий                                      10.x         11 без интеграции     с OtelEventTrace
 *   (а) в OTel-спане, sentry-trace браузера       OTel-спан    браузер               OTel-спан
 *   (б) в OTel-спане, без sentry-trace            OTel-спан    http.server Sentry    OTel-спан
 *   (в) вне спана, sentry-trace браузера          браузер      браузер               браузер
 *   (г) вне спана, без sentry-trace               http.server  http.server Sentry    http.server Sentry
 */

interface SpanIds {
  traceId: string
  spanId: string
}
interface TraceContext {
  trace_id?: string
  span_id?: string
  parent_span_id?: string
}
interface TrafficEvent {
  message?: string
  exceptionValue?: string
  mechanism?: string
  trace?: TraceContext
}
interface OtelTrace {
  mode: string
  browser: SpanIds
  integrations: string[]
  cases: Record<string, { otel?: SpanIds; sentry?: SpanIds }>
  events: TrafficEvent[]
}

const FIXTURE = fileURLToPath(new URL('../fixtures/sentry-traffic/server-otel-trace.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/* Режимы фикстуры: module — опции модуля; defaults — дефолты SDK + только наша интеграция; bare —
   `defaultIntegrations: false`. Упавший запуск одного режима роняет только тесты этого режима: ошибка хранится и бросается из runOf(). */
const MODES = ['module', 'defaults', 'bare']
const runs = new Map<string, OtelTrace | Error>()

function runFixture(mode: string): OtelTrace {
  const run = spawnSync(process.versions.bun ? process.execPath : 'bun', [FIXTURE, mode], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.status !== 0) {
    throw new Error(`фикстура «${mode}» упала (status=${String(run.status)}): ${run.stderr.slice(-2000)}`)
  }
  return JSON.parse(run.stdout) as OtelTrace
}

function eventTitled(run: OtelTrace, title: string): TrafficEvent {
  const found = run.events.find((event) => event.message === title || event.exceptionValue === title)
  if (!found) {
    throw new Error(
      `событие «${title}» не дошло до ловушки; пришли: ${JSON.stringify(run.events.map((event) => event.message ?? event.exceptionValue))}`,
    )
  }
  return found
}

/* Что видел обработчик запроса сценария: активный OTel-спан (его нет в сценариях «вне спана») и http.server-спан Sentry. */
function seenBy(run: OtelTrace, label: string): { otel: SpanIds | undefined; sentry: SpanIds } {
  const seen = run.cases[label]
  if (seen?.sentry === undefined) {
    throw new Error(`обработчик «${label}» не записал спан Sentry: ${JSON.stringify(run.cases)}`)
  }
  return { otel: seen.otel, sentry: seen.sentry }
}

function otelOf(run: OtelTrace, label: string): SpanIds {
  const otel = run.cases[label]?.otel
  if (otel === undefined) {
    throw new Error(`обработчик «${label}» не создал OTel-спан: ${JSON.stringify(run.cases)}`)
  }
  return otel
}

function expectSpanIds(run: OtelTrace, label: string, kinds: string[]): void {
  const otel = otelOf(run, label)
  for (const kind of kinds) {
    expect(eventTitled(run, `${label}:${kind}`).trace, `${run.mode}: ${label}:${kind}`).toMatchObject({
      trace_id: otel.traceId,
      span_id: otel.spanId,
    })
  }
}

beforeAll(() => {
  for (const mode of MODES) {
    try {
      runs.set(mode, runFixture(mode))
    } catch (error) {
      runs.set(mode, error instanceof Error ? error : new Error(String(error)))
    }
  }
}, 120_000)

function runOf(mode: string): OtelTrace {
  const run = runs.get(mode)
  if (run === undefined) {
    throw new Error(`фикстура «${mode}» не запускалась`)
  }
  if (run instanceof Error) {
    throw run
  }
  return run
}

describe('серверный Sentry: trace_id события внутри OTel-спана (спан chassis ядра)', () => {
  it('(а) в спане, запрос с sentry-trace браузера → trace_id и span_id OTel-спана, а не браузера', () => {
    const moduleRun = runOf('module')
    const otel = otelOf(moduleRun, 'inside-with')
    const { sentry } = seenBy(moduleRun, 'inside-with')
    const context = eventTitled(moduleRun, 'inside-with:message').trace
    /* Предпосылка: Sentry продолжил trace браузера, так что без интеграции событие несло бы его. */
    expect(sentry.traceId).toBe(moduleRun.browser.traceId)
    expect(otel.traceId).not.toBe(moduleRun.browser.traceId)
    expect(context?.trace_id).toBe(otel.traceId)
    expect(context?.span_id).toBe(otel.spanId)
    /* Контекст не смешан с http.server-спаном: его parent_span_id (спан браузера) у спана chassis не бывает. */
    expect(context?.parent_span_id).toBeUndefined()
  })

  it('(б) в спане, запрос без sentry-trace → trace_id и span_id OTel-спана, а не http.server-спана Sentry', () => {
    const moduleRun = runOf('module')
    const otel = otelOf(moduleRun, 'inside-without')
    const { sentry } = seenBy(moduleRun, 'inside-without')
    const context = eventTitled(moduleRun, 'inside-without:message').trace
    expect(otel.traceId).not.toBe(sentry.traceId)
    expect(context?.trace_id).toBe(otel.traceId)
    expect(context?.span_id).toBe(otel.spanId)
    expect(context?.parent_span_id).toBeUndefined()
  })

  it('(в) вне спана, запрос с sentry-trace браузера → trace_id браузера, как на 10.x', () => {
    const moduleRun = runOf('module')
    const { otel, sentry } = seenBy(moduleRun, 'outside-with')
    const context = eventTitled(moduleRun, 'outside-with:message').trace
    expect(otel).toBeUndefined()
    expect(context?.trace_id).toBe(moduleRun.browser.traceId)
    expect(context?.span_id).toBe(sentry.spanId)
    expect(context?.parent_span_id).toBe(moduleRun.browser.spanId)
  })

  it('(г) вне спана, запрос без sentry-trace → trace_id есть и это trace http.server-спана Sentry', () => {
    const moduleRun = runOf('module')
    const { otel, sentry } = seenBy(moduleRun, 'outside-without')
    const context = eventTitled(moduleRun, 'outside-without:message').trace
    expect(otel).toBeUndefined()
    expect(context?.trace_id).toMatch(/^[0-9a-f]{32}$/u)
    expect(context?.trace_id).toBe(sentry.traceId)
    expect(context?.trace_id).not.toBe(moduleRun.browser.traceId)
    expect(context?.span_id).toBe(sentry.spanId)
  })
})

describe('серверный Sentry: OtelEventTrace — пути захвата, границы, независимость от прочих интеграций', () => {
  it('captureException и console.error в спане несут тот же trace_id и span_id, что captureMessage (оба запроса)', () => {
    const moduleRun = runOf('module')
    for (const label of ['inside-with', 'inside-without']) {
      expectSpanIds(moduleRun, label, ['message', 'exception', 'console'])
    }
  })

  it('вне спана captureException и console.error остаются на trace Sentry — как captureMessage', () => {
    const moduleRun = runOf('module')
    for (const label of ['outside-with', 'outside-without']) {
      const { sentry } = seenBy(moduleRun, label)
      for (const kind of ['message', 'exception', 'console']) {
        expect(eventTitled(moduleRun, `${label}:${kind}`).trace, `${label}:${kind}`).toMatchObject({
          trace_id: sentry.traceId,
          span_id: sentry.spanId,
        })
      }
    }
  })

  it('активный OTel-спан с невалидным контекстом (нули) → событие не трогаем: trace Sentry, как вне спана', () => {
    const moduleRun = runOf('module')
    const { sentry } = seenBy(moduleRun, 'invalid-with')
    for (const kind of ['message', 'exception', 'console']) {
      expect(eventTitled(moduleRun, `invalid-with:${kind}`).trace, kind).toMatchObject({
        trace_id: moduleRun.browser.traceId,
        span_id: sentry.spanId,
        parent_span_id: moduleRun.browser.spanId,
      })
    }
  })

  it('интеграция OtelEventTrace стоит в клиенте после init с опциями модуля', () => {
    const moduleRun = runOf('module')
    expect(moduleRun.integrations).toContain('OtelEventTrace')
  })

  it('дефолтные интеграции SDK + OtelEventTrace (опции модуля не нужны): события в спане — с trace_id и span_id OTel', () => {
    const defaultsRun = runOf('defaults')
    expect(defaultsRun.integrations).toEqual(expect.arrayContaining(['BunServer', 'OtelEventTrace']))
    for (const label of ['inside-with', 'inside-without']) {
      expectSpanIds(defaultsRun, label, ['message', 'exception'])
    }
  })

  it('defaultIntegrations: false (как chassis initSentry у сервисов): события в спане — с trace_id и span_id OTel', () => {
    const bareRun = runOf('bare')
    expect(bareRun.integrations).toContain('OtelEventTrace')
    expect(bareRun.integrations).not.toContain('BunServer')
    for (const label of ['inside-with', 'inside-without']) {
      expectSpanIds(bareRun, label, ['message', 'exception'])
    }
  })
})
