import { INVALID_SPAN_CONTEXT, trace, type Span, type SpanContext } from '@opentelemetry/api'
import type { Client, Event } from '@sentry/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { otelEventTraceIntegration } from '../../src/runtime/utils/otel-event-trace'

/*
 * Логика хука OtelEventTrace без Sentry и без процесса: поддельный клиент ловит подписку, активный OTel-спан подменяет
 * шпион на `trace.getActiveSpan` (валидность контекста проверяет настоящий `trace.isSpanContextValid`). Что хук делает
 * в живом SDK — server-otel-event-trace.test.ts.
 */

const SPAN = { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331', traceFlags: 1 }

/* Без аргумента активного спана нет. */
function activeSpan(spanContext?: SpanContext): void {
  vi.spyOn(trace, 'getActiveSpan').mockReturnValue(
    spanContext === undefined ? undefined : ({ spanContext: () => spanContext } as unknown as Span),
  )
}

function subscribe(): { hooks: string[]; preprocess: (event: Event) => void } {
  const hooks: string[] = []
  let preprocess: ((event: Event) => void) | undefined
  const client = {
    on(hook: string, listener: (event: Event) => void) {
      hooks.push(hook)
      if (hook === 'preprocessEvent') {
        preprocess = listener
      }
      return vi.fn()
    },
  } as unknown as Client
  otelEventTraceIntegration().setup?.(client)
  if (preprocess === undefined) {
    throw new Error('интеграция не подписалась на preprocessEvent')
  }
  return { hooks, preprocess }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OtelEventTrace: подписка', () => {
  it('называется OtelEventTrace и подписывается только на preprocessEvent — до prepareEvent, где scope кладёт свой спан', () => {
    expect(otelEventTraceIntegration().name).toBe('OtelEventTrace')
    expect(subscribe().hooks).toEqual(['preprocessEvent'])
  })
})

describe('OtelEventTrace: активный валидный OTel-спан', () => {
  it('ставит trace_id и span_id спана; остальные контексты события на месте', () => {
    activeSpan(SPAN)
    const event: Event = { message: 'boom', contexts: { os: { name: 'Linux' } } }
    subscribe().preprocess(event)
    expect(event.contexts).toEqual({ os: { name: 'Linux' }, trace: { trace_id: SPAN.traceId, span_id: SPAN.spanId } })
  })

  it('у события без contexts создаёт их; чужие поля уже лежащего trace (op, data) не стирает, id перекрывает', () => {
    activeSpan(SPAN)
    const bare: Event = { message: 'bare' }
    const withTrace: Event = {
      message: 'with trace',
      contexts: { trace: { trace_id: 'c'.repeat(32), span_id: 'd'.repeat(16), op: 'custom', data: { key: 'value' } } },
    }
    const { preprocess } = subscribe()
    preprocess(bare)
    preprocess(withTrace)
    expect(bare.contexts?.trace).toEqual({ trace_id: SPAN.traceId, span_id: SPAN.spanId })
    expect(withTrace.contexts?.trace).toEqual({
      trace_id: SPAN.traceId,
      span_id: SPAN.spanId,
      op: 'custom',
      data: { key: 'value' },
    })
  })
})

describe('OtelEventTrace: событие не трогаем', () => {
  it('вне спана (активного спана нет — менеджер контекста не стоит или спан не открыт)', () => {
    activeSpan()
    const event: Event = { message: 'plain', contexts: { os: { name: 'Linux' } } }
    subscribe().preprocess(event)
    expect(event).toEqual({ message: 'plain', contexts: { os: { name: 'Linux' } } })
  })

  it('активный спан с невалидным контекстом: нулевые trace_id/span_id', () => {
    activeSpan(INVALID_SPAN_CONTEXT)
    const event: Event = { message: 'invalid' }
    subscribe().preprocess(event)
    expect(event).toEqual({ message: 'invalid' })
  })

  it('невалидный span_id при валидном trace_id тоже невалиден', () => {
    activeSpan({ ...SPAN, spanId: '0'.repeat(16) })
    const event: Event = { message: 'half-invalid' }
    subscribe().preprocess(event)
    expect(event).toEqual({ message: 'half-invalid' })
  })

  it('транзакция внутри OTel-спана: у неё свой контекст и свой span_id, подмена сломала бы дерево спанов', () => {
    activeSpan(SPAN)
    const transaction: Event = {
      type: 'transaction',
      transaction: 'GET /x',
      contexts: { trace: { trace_id: 'e'.repeat(32), span_id: 'f'.repeat(16) } },
    }
    subscribe().preprocess(transaction)
    expect(transaction.contexts?.trace).toEqual({ trace_id: 'e'.repeat(32), span_id: 'f'.repeat(16) })
  })
})
