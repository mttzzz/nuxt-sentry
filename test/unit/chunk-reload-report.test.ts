import { createSentryStaleChunkFilter } from '@mttzzz/nuxt-stale-deploy-guard/sentry'
import { Scope, ServerRuntimeClient, createTransport, eventFiltersIntegration, type Event } from '@sentry/core'
import { describe, expect, it, vi } from 'vitest'

import { createClientBeforeSend } from '../../src/runtime/utils/before-send'
import {
  CHUNK_REASON_TAG,
  createChunkReloadBlockedReporter,
  isChunkReloadBlockedEvent,
  toChunkReloadBlockedEvent,
  type ChunkReloadBlockedDetail,
  type ChunkReloadBlockedReason,
} from '../../src/runtime/utils/chunk-reload-report'
import { buildIgnoreErrors, isIgnoredSentryMessage } from '../../src/runtime/utils/ignore-errors'

/* Тексты и стек — как у реального сбоя из инцидента ai.pushka.biz 15.10.2026. */
const CHUNK_MESSAGE = 'Failed to fetch dynamically imported module: https://ai.pushka.biz/_nuxt/Dxf3k1.js'
const ROUTER_MESSAGE = 'Couldn\'t resolve component "default" at "/invite/:code()"'

function makeError(message: string, name = 'TypeError'): Error {
  const error = new Error(message)
  error.name = name
  error.stack = `${name}: ${message}\n    at loadChunk (https://ai.pushka.biz/_nuxt/entry.js:1:2)`
  return error
}

const PROBES = ['/_nuxt/builds/latest.json', '/_nuxt/builds/meta/a1.json', '/_nuxt/builds/meta/a2.json']

/* По одному полному detail на каждую причину — ровно то, что шлёт guard. */
const DETAILS: Record<ChunkReloadBlockedReason, ChunkReloadBlockedDetail> = {
  'unsupported-browser': { reason: 'unsupported-browser', missing: 'importmap' },
  'not-stale': { reason: 'not-stale', error: makeError(CHUNK_MESSAGE), probes: PROBES, buildId: 'b-1' },
  'circuit-breaker': {
    reason: 'circuit-breaker',
    error: makeError(ROUTER_MESSAGE, 'Error'),
    probes: PROBES,
    buildId: 'b-2',
    attempts: 3,
    windowMs: 60_000,
  },
  cooldown: { reason: 'cooldown', error: makeError(CHUNK_MESSAGE), buildId: 'b-3' },
  'no-build-id': { reason: 'no-build-id', error: makeError(CHUNK_MESSAGE) },
  'retry-failed': { reason: 'retry-failed', kind: 'chunk', error: makeError(CHUNK_MESSAGE) },
}

const REASONS = Object.keys(DETAILS) as ChunkReloadBlockedReason[]

function errorContext(error: Error) {
  return { name: error.name, message: error.message, stack: error.stack }
}

interface ChunkContext {
  reason?: string
  error?: { name?: string; message: string; stack?: string }
  probes?: string[]
  buildId?: string
  attempts?: number
  windowMs?: number
}

function chunkContext(event: Event): ChunkContext {
  return event.contexts?.chunk as ChunkContext
}

function notStaleWith(error: unknown): ChunkReloadBlockedDetail {
  return { reason: 'not-stale', error, probes: [], buildId: 'b' }
}

describe('toChunkReloadBlockedEvent', () => {
  it('unsupported-browser → warning, тег chunk.missing, без сведений об ошибке', () => {
    expect(toChunkReloadBlockedEvent({ reason: 'unsupported-browser', missing: 'importmap' })).toEqual({
      message: 'Браузер без import maps',
      level: 'warning',
      fingerprint: ['chunk-reload-blocked', 'unsupported-browser'],
      tags: { 'chunk.reason': 'unsupported-browser', 'chunk.missing': 'importmap' },
      contexts: { chunk: { reason: 'unsupported-browser' } },
    })
  })

  it('not-stale → error, ошибка и пробы в контексте, сообщение ошибки в теге', () => {
    const error = makeError(CHUNK_MESSAGE)
    expect(toChunkReloadBlockedEvent({ reason: 'not-stale', error, probes: PROBES, buildId: 'b-1' })).toEqual({
      message: 'Чанк не загрузился, билд актуален',
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'not-stale'],
      tags: { 'chunk.reason': 'not-stale', 'chunk.error': CHUNK_MESSAGE },
      contexts: { chunk: { reason: 'not-stale', error: errorContext(error), probes: PROBES, buildId: 'b-1' } },
    })
  })

  it('circuit-breaker → error, плюс attempts и windowMs', () => {
    const error = makeError(ROUTER_MESSAGE, 'Error')
    expect(
      toChunkReloadBlockedEvent({
        reason: 'circuit-breaker',
        error,
        probes: PROBES,
        buildId: 'b-2',
        attempts: 3,
        windowMs: 60_000,
      }),
    ).toEqual({
      message: 'Чанк не загрузился, перезагрузки исчерпаны',
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'circuit-breaker'],
      tags: { 'chunk.reason': 'circuit-breaker', 'chunk.error': ROUTER_MESSAGE },
      contexts: {
        chunk: {
          reason: 'circuit-breaker',
          error: errorContext(error),
          probes: PROBES,
          buildId: 'b-2',
          attempts: 3,
          windowMs: 60_000,
        },
      },
    })
  })

  it('cooldown → error, buildId без проб', () => {
    const error = makeError(CHUNK_MESSAGE)
    expect(toChunkReloadBlockedEvent({ reason: 'cooldown', error, buildId: 'b-3' })).toEqual({
      message: 'Чанк не загрузился сразу после перезагрузки',
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'cooldown'],
      tags: { 'chunk.reason': 'cooldown', 'chunk.error': CHUNK_MESSAGE },
      contexts: { chunk: { reason: 'cooldown', error: errorContext(error), buildId: 'b-3' } },
    })
  })

  it('no-build-id → error, только ошибка', () => {
    const error = makeError(CHUNK_MESSAGE)
    expect(toChunkReloadBlockedEvent({ reason: 'no-build-id', error })).toEqual({
      message: 'Чанк не загрузился, build-id неизвестен',
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'no-build-id'],
      tags: { 'chunk.reason': 'no-build-id', 'chunk.error': CHUNK_MESSAGE },
      contexts: { chunk: { reason: 'no-build-id', error: errorContext(error) } },
    })
  })

  it('исходная ошибка — не exception и не cause (её текст матчится ignoreErrors и отчёт бы срезало)', () => {
    const event = toChunkReloadBlockedEvent(notStaleWith(makeError(CHUNK_MESSAGE)))

    expect(event.exception).toBeUndefined()
    expect(event.threads).toBeUndefined()
    expect(Object.keys(event).toSorted()).toEqual(['contexts', 'fingerprint', 'level', 'message', 'tags'])
  })

  describe('исходная ошибка', () => {
    it('длинное сообщение: тег — первые 200 символов, текст и стек в контексте — не длиннее 2000', () => {
      const error = makeError('x'.repeat(5000))
      error.stack = `TypeError: ${'s'.repeat(9000)}`

      const event = toChunkReloadBlockedEvent(notStaleWith(error))

      expect(event.tags?.['chunk.error']).toBe('x'.repeat(200))
      const { error: summary } = chunkContext(event)
      expect(summary?.message).toBe('x'.repeat(2000))
      expect(summary?.stack).toHaveLength(2000)
    })

    it('обрезка не оставляет половину суррогатной пары (иначе JSON невалиден для сервера)', () => {
      const error = makeError(`${'a'.repeat(199)}😀tail`)

      const tag = toChunkReloadBlockedEvent(notStaleWith(error)).tags?.['chunk.error']

      expect(tag).toBe('a'.repeat(199))
      expect(String(tag).isWellFormed()).toBe(true)
    })

    it('перевод строки в сообщении не попадает в тег (значение тега — одна строка)', () => {
      const error = makeError('Failed to fetch\n  dynamically imported\r\nmodule')

      const event = toChunkReloadBlockedEvent(notStaleWith(error))

      expect(event.tags?.['chunk.error']).toBe('Failed to fetch dynamically imported module')
      expect(chunkContext(event).error?.message).toBe(error.message)
    })

    it('строка вместо Error: сообщение = строка, без name и stack', () => {
      const event = toChunkReloadBlockedEvent(notStaleWith('Importing a module script failed.'))

      expect(event.tags?.['chunk.error']).toBe('Importing a module script failed.')
      expect(chunkContext(event).error).toEqual({ message: 'Importing a module script failed.' })
    })

    it('undefined / null — без тега chunk.error и без error в контексте', () => {
      for (const error of [undefined, null]) {
        const event = toChunkReloadBlockedEvent(notStaleWith(error))
        expect(event.tags).toEqual({ 'chunk.reason': 'not-stale' })
        expect(event.contexts?.chunk).not.toHaveProperty('error')
      }
    })

    it('пустое сообщение: ошибка в контексте есть, пустой тег не создаётся', () => {
      const event = toChunkReloadBlockedEvent(notStaleWith(makeError('')))

      expect(event.tags).toEqual({ 'chunk.reason': 'not-stale' })
      expect(event.contexts?.chunk).toHaveProperty('error')
    })

    it('не-Error значения (объект с message, объект без него, число, циклическая структура) не ломают маппинг', () => {
      const circular: Record<string, unknown> = { code: 1 }
      circular.self = circular
      function tagOf(error: unknown) {
        return toChunkReloadBlockedEvent(notStaleWith(error)).tags?.['chunk.error']
      }

      expect(tagOf({ message: 'from event', filename: 'x.js' })).toBe('from event')
      expect(tagOf({ code: 7 })).toBe('{"code":7}')
      expect(tagOf(404)).toBe('404')
      expect(tagOf(circular)).toBe('[object Object]')
    })

    it('объект, чьё чтение свойств бросает: отчёт уходит без сведений об ошибке, а не теряется', () => {
      const hostile = new Proxy(
        {},
        {
          has() {
            throw new Error('revoked')
          },
        },
      )

      const event = toChunkReloadBlockedEvent(notStaleWith(hostile))

      expect(event.message).toBe('Чанк не загрузился, билд актуален')
      expect(event.tags).toEqual({ 'chunk.reason': 'not-stale' })
    })
  })

  it('поля чужой ревизии guard с неверным типом отбрасываются, а не пишутся в контекст как есть', () => {
    const detail = {
      reason: 'circuit-breaker',
      probes: ['/a', 7, null],
      buildId: 42,
      attempts: '3',
      windowMs: Number.NaN,
    } as unknown as ChunkReloadBlockedDetail

    expect(toChunkReloadBlockedEvent(detail).contexts?.chunk).toEqual({ reason: 'circuit-breaker', probes: ['/a'] })
  })
})

describe('createChunkReloadBlockedReporter', () => {
  const notStale = DETAILS['not-stale']

  it('одно событие на reason за загрузку страницы', () => {
    const capture = vi.fn<(event: Event) => void>()
    const report = createChunkReloadBlockedReporter(capture)

    report(notStale)
    report({ ...notStale, buildId: 'другой' })
    report(notStale)

    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith(toChunkReloadBlockedEvent(notStale))
  })

  it('разные reason — разные события', () => {
    const capture = vi.fn<(event: Event) => void>()
    const report = createChunkReloadBlockedReporter(capture)

    report(notStale)
    report(DETAILS.cooldown)
    report(DETAILS['no-build-id'])
    report(DETAILS.cooldown)

    expect(capture.mock.calls.map(([event]) => event.tags?.[CHUNK_REASON_TAG])).toEqual([
      'not-stale',
      'cooldown',
      'no-build-id',
    ])
  })

  it('дедуп у каждого репортёра свой (новая загрузка страницы — новый счёт)', () => {
    const first = vi.fn<(event: Event) => void>()
    const second = vi.fn<(event: Event) => void>()

    createChunkReloadBlockedReporter(first)(notStale)
    createChunkReloadBlockedReporter(second)(notStale)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['строка', 'not-stale'],
    ['пустой объект', {}],
    ['неизвестный reason', { reason: 'brand-new-reason' }],
    ['reason не строка', { reason: 42 }],
    ['reason из прототипа Object', { reason: 'constructor' }],
  ])('невалидный detail (%s) молча игнорируется', (_name, detail) => {
    const capture = vi.fn<(event: Event) => void>()
    const report = createChunkReloadBlockedReporter(capture)

    expect(() => {
      report(detail)
    }).not.toThrow()
    expect(capture).not.toHaveBeenCalled()
  })

  it('невалидный detail не тратит дедуп: следующий валидный того же репортёра уходит', () => {
    const capture = vi.fn<(event: Event) => void>()
    const report = createChunkReloadBlockedReporter(capture)

    report({ reason: 'not-stale-typo' })
    report(notStale)

    expect(capture).toHaveBeenCalledTimes(1)
  })
})

describe('заголовки отчёта и ignoreErrors', () => {
  it.each(REASONS)('заголовок %s не матчится ни одним паттерном buildIgnoreErrors()', (reason) => {
    const message = toChunkReloadBlockedEvent(DETAILS[reason]).message ?? ''

    expect(message).not.toBe('')
    expect(isIgnoredSentryMessage(message)).toBe(false)
    expect(
      buildIgnoreErrors().some((pattern) =>
        typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message),
      ),
    ).toBe(false)
  })

  it('контрольная пара: текст самой ошибки ignoreErrors срезает — поэтому она не exception', () => {
    expect(isIgnoredSentryMessage(CHUNK_MESSAGE)).toBe(true)
    expect(isIgnoredSentryMessage(ROUTER_MESSAGE)).toBe(true)
  })
})

describe('isChunkReloadBlockedEvent', () => {
  it('узнаёт отчёт по тегу chunk.reason', () => {
    expect(isChunkReloadBlockedEvent(toChunkReloadBlockedEvent(DETAILS['no-build-id']))).toBe(true)
  })

  it('обычные события — нет', () => {
    expect(isChunkReloadBlockedEvent({ message: 'boom' })).toBe(false)
    expect(isChunkReloadBlockedEvent({ message: 'boom', tags: { route: '/x' } })).toBe(false)
  })
})

/*
 * Сквозной прогон через настоящий клиент Sentry: ignoreErrors (eventFiltersIntegration) → beforeSend
 * клиента (createClientBeforeSend с реальным staleChunkFilter guard'а) → транспорт. Ровно та цепочка,
 * в которой отчёт молча терялся бы, окажись его заголовок в ignoreErrors или пойди он через
 * staleChunkFilter.
 */
describe('прохождение через Sentry-клиент', () => {
  function createPipeline() {
    const envelopes: string[] = []
    const client = new ServerRuntimeClient({
      dsn: 'https://key@o0.ingest.sentry.io/1',
      integrations: [eventFiltersIntegration()],
      ignoreErrors: buildIgnoreErrors(),
      beforeSend: createClientBeforeSend(createSentryStaleChunkFilter()),
      stackParser: () => [],
      transport: () =>
        createTransport({ recordDroppedEvent: () => {} }, (request) => {
          envelopes.push(String(request.body))
          return Promise.resolve({ statusCode: 200 })
        }),
    })
    client.init()
    const scope = new Scope()
    scope.setClient(client)
    /* Свежий console.error про stale-chunk — то, что видит staleChunkFilter в окне 5 с перед отчётом. */
    scope.addBreadcrumb({ category: 'console', level: 'error', message: ROUTER_MESSAGE })

    async function send(event: Event): Promise<Event[]> {
      envelopes.length = 0
      client.captureEvent(event, undefined, scope)
      await client.flush(2000)
      return envelopes.map((envelope) => JSON.parse(envelope.split('\n')[2] ?? '{}') as Event)
    }
    return { send }
  }

  it.each(REASONS)('отчёт %s доходит до транспорта даже со свежим stale-chunk breadcrumb', async (reason) => {
    const { send } = createPipeline()

    const delivered = await send(toChunkReloadBlockedEvent(DETAILS[reason]))

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      message: toChunkReloadBlockedEvent(DETAILS[reason]).message,
      fingerprint: toChunkReloadBlockedEvent(DETAILS[reason]).fingerprint,
      tags: { 'chunk.reason': reason },
    })
  })

  it('контроль стенда: обычное событие в том же окне срезает staleChunkFilter', async () => {
    const { send } = createPipeline()

    expect(await send({ message: 'Cannot read properties of undefined (reading "p")', level: 'error' })).toEqual([])
  })

  it('контроль стенда: событие с текстом stale-chunk ошибки срезает ignoreErrors', async () => {
    const { send } = createPipeline()

    expect(await send({ message: CHUNK_MESSAGE, level: 'error' })).toEqual([])
  })
})
