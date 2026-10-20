import type { Event } from '@sentry/core'
import { describe, expect, it } from 'vitest'

import { toChunkReloadBlockedEvent, type ChunkReloadBlockedDetail } from '../../src/runtime/utils/chunk-reload-report'
import {
  DSN,
  IPHONE_UA,
  PAGE,
  TUNNEL,
  UNSUPPORTED,
  beaconEnvelope,
  boot,
  parseEnvelope,
  type Envelope,
} from './helpers/early-beacon-page'

const TITLE = 'Страница не загрузилась и после перезагрузки'
const CHUNK_URL = 'https://cdn.pushka.biz/_nuxt/Dxf3k1.js'
const CHUNK_MESSAGE = `Failed to fetch dynamically imported module: ${CHUNK_URL}`
const ENTRY_URL = 'https://cdn.pushka.biz/_nuxt/entry.DkQ1x.js'
const KINDS = ['chunk', 'entry'] as const

function chunkError(): TypeError {
  const error = new TypeError(CHUNK_MESSAGE)
  error.stack = `TypeError: ${CHUNK_MESSAGE}\n    at loadChunk (${ENTRY_URL}:1:2)`
  return error
}

/* То, что событие берёт из detail и вшитого шаблона; остальное (request, release, sdk…) — поля браузера. */
function reportOf(event: Event | Envelope['payload']) {
  const { message, level, fingerprint, tags, contexts } = event
  return { message, level, fingerprint, tags, contexts }
}

function sentReport(detail: unknown) {
  const page = boot()
  page.dispatch(detail)
  return reportOf(beaconEnvelope(page).payload)
}

describe('ранний beacon: retry-failed', () => {
  it('kind chunk с ошибкой: один sendBeacon на tunnel, событие по контракту', () => {
    const error = chunkError()
    const page = boot()

    page.dispatch({ reason: 'retry-failed', kind: 'chunk', error })

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
    expect(page.sendBeacon.mock.calls[0]?.[0]).toBe(TUNNEL)
    expect(page.sendBeacon.mock.contexts[0]).toBe(page.navigator)
    expect(page.fetch).not.toHaveBeenCalled()
    const { header, item, payload } = beaconEnvelope(page)
    expect(header.dsn).toBe(DSN)
    expect(header.event_id).toBe(payload.event_id)
    expect(item).toEqual({ type: 'event' })
    expect(reportOf(payload)).toEqual({
      message: TITLE,
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'retry-failed', 'chunk'],
      tags: { 'chunk.reason': 'retry-failed', 'chunk.kind': 'chunk', 'chunk.error': CHUNK_MESSAGE },
      contexts: {
        chunk: {
          reason: 'retry-failed',
          kind: 'chunk',
          error: { name: 'TypeError', message: CHUNK_MESSAGE, stack: error.stack },
        },
      },
    })
    expect(payload).toMatchObject({
      platform: 'javascript',
      request: { url: PAGE, headers: { 'User-Agent': IPHONE_UA } },
      release: 'a1b2c3d',
      environment: 'production',
      sdk: { name: 'nuxt-sentry.early-beacon', version: '0.10.0' },
    })
    expect(Math.abs(payload.timestamp - Date.now() / 1000)).toBeLessThan(5)
  })

  it('kind entry с адресом скрипта и без ошибки: url в контексте, тега chunk.error нет', () => {
    expect(sentReport({ reason: 'retry-failed', kind: 'entry', url: ENTRY_URL })).toEqual({
      message: TITLE,
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'retry-failed', 'entry'],
      tags: { 'chunk.reason': 'retry-failed', 'chunk.kind': 'entry' },
      contexts: { chunk: { reason: 'retry-failed', kind: 'entry', url: ENTRY_URL } },
    })
  })

  it('kind entry с ошибкой-строкой и адресом: оба поля доезжают', () => {
    expect(
      sentReport({ reason: 'retry-failed', kind: 'entry', error: 'Importing a module script failed.', url: ENTRY_URL }),
    ).toEqual({
      message: TITLE,
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'retry-failed', 'entry'],
      tags: {
        'chunk.reason': 'retry-failed',
        'chunk.kind': 'entry',
        'chunk.error': 'Importing a module script failed.',
      },
      contexts: {
        chunk: {
          reason: 'retry-failed',
          kind: 'entry',
          error: { message: 'Importing a module script failed.' },
          url: ENTRY_URL,
        },
      },
    })
  })

  it.each(KINDS)('kind %s без error и url: событие — готовый шаблон, без полей из браузера', (kind) => {
    const report = sentReport({ reason: 'retry-failed', kind })

    expect(report).toEqual(reportOf(toChunkReloadBlockedEvent({ reason: 'retry-failed', kind })))
    expect(report.contexts).toEqual({ chunk: { reason: 'retry-failed', kind } })
  })
})

describe('ранний beacon: retry-failed совпадает с SDK-мапингом на тех же данных', () => {
  const circular: Record<string, unknown> = { code: 1 }
  circular.self = circular
  const hostile = new Proxy(
    {},
    {
      has() {
        throw new Error('revoked')
      },
    },
  )
  const huge = Object.assign(new Error('x'.repeat(5000)), { stack: `Error: ${'s'.repeat(9000)}` })

  it.each<[string, unknown]>([
    ['Error со стеком', chunkError()],
    ['строка', 'Importing a module script failed.'],
    ['объект с message (ErrorEvent)', { message: 'Script error.', filename: ENTRY_URL }],
    ['объект без message', { code: 7 }],
    ['число', 404],
    ['null', null],
    ['undefined', undefined],
    ['пустое сообщение', Object.assign(new Error('placeholder'), { message: '' })],
    ['многострочное сообщение', new Error('Failed to fetch\n  dynamically imported\r\nmodule')],
    ['длинные сообщение и стек', huge],
    ['обрезка на суррогатной паре', new Error(`${'a'.repeat(199)}😀tail`)],
    ['циклическая структура', circular],
    ['объект, чьё чтение свойств бросает', hostile],
  ])('ошибка: %s', (_name, error) => {
    for (const kind of KINDS) {
      const detail: ChunkReloadBlockedDetail = { reason: 'retry-failed', kind, error }

      expect(sentReport(detail)).toEqual(reportOf(toChunkReloadBlockedEvent(detail)))
    }
  })

  it.each<[string, unknown]>([
    ['обычный адрес', ENTRY_URL],
    ['пустая строка', ''],
    ['не строка', 42],
    ['очень длинный адрес', `${CHUNK_URL}?${'q'.repeat(3000)}`],
  ])('url: %s', (_name, url) => {
    const detail: unknown = { reason: 'retry-failed', kind: 'entry', url }

    expect(sentReport(detail)).toEqual(reportOf(toChunkReloadBlockedEvent(detail as ChunkReloadBlockedDetail)))
  })

  it('detail с бросающим геттером error: событие всё равно уходит, без сведений об ошибке', () => {
    const detail = {
      reason: 'retry-failed',
      kind: 'chunk',
      get error(): unknown {
        throw new Error('boom')
      },
    }

    expect(sentReport(detail)).toEqual(reportOf(toChunkReloadBlockedEvent({ reason: 'retry-failed', kind: 'chunk' })))
  })
})

describe('ранний beacon: retry-failed — дедуп и валидность', () => {
  it('повторный retry-failed (в том числе другого kind) — всё ещё одно событие', () => {
    const page = boot()

    page.dispatch({ reason: 'retry-failed', kind: 'chunk' })
    page.dispatch({ reason: 'retry-failed', kind: 'chunk', error: 'again' })
    page.dispatch({ reason: 'retry-failed', kind: 'entry' })

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
    expect(beaconEnvelope(page).payload.fingerprint).toEqual(['chunk-reload-blocked', 'retry-failed', 'chunk'])
  })

  it('unsupported-browser и retry-failed — разные reason: по одному событию на каждый', () => {
    const page = boot()

    page.dispatch(UNSUPPORTED)
    page.dispatch({ reason: 'retry-failed', kind: 'entry' })
    page.dispatch(UNSUPPORTED)
    page.dispatch({ reason: 'retry-failed', kind: 'chunk' })

    expect(page.sendBeacon).toHaveBeenCalledTimes(2)
    expect(beaconEnvelope(page, 0).payload.tags).toMatchObject({ 'chunk.reason': 'unsupported-browser' })
    expect(beaconEnvelope(page, 1).payload.tags).toMatchObject({ 'chunk.reason': 'retry-failed' })
  })

  it.each([
    ['без kind', { reason: 'retry-failed' }],
    ['неизвестный kind', { reason: 'retry-failed', kind: 'page' }],
    ['kind не строка', { reason: 'retry-failed', kind: 42 }],
    ['kind — массив с валидным значением', { reason: 'retry-failed', kind: ['chunk'] }],
    ['kind в другом регистре', { reason: 'retry-failed', kind: 'Chunk' }],
    ['kind из прототипа Object', { reason: 'retry-failed', kind: 'constructor' }],
  ])('невалидный detail (%s) ничего не шлёт и не тратит дедуп', (_name, detail) => {
    const page = boot()

    page.dispatch(detail)

    expect(page.sendBeacon).not.toHaveBeenCalled()
    expect(page.fetch).not.toHaveBeenCalled()
    page.dispatch({ reason: 'retry-failed', kind: 'chunk' })
    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
  })
})

describe('ранний beacon: retry-failed — гейт и доставка как у unsupported-browser', () => {
  it.each(KINDS)('localhost при excludeLocalhostInProd: kind %s не отправляется', (kind) => {
    const page = boot({ excludeLocalhostInProd: true }, { hostname: 'localhost' })

    page.dispatch({ reason: 'retry-failed', kind })

    expect(page.sendBeacon).not.toHaveBeenCalled()
    expect(page.fetch).not.toHaveBeenCalled()
  })

  it('localhost при excludeLocalhostInProd: false — отправляется', () => {
    const page = boot({ excludeLocalhostInProd: false }, { hostname: 'localhost' })

    page.dispatch({ reason: 'retry-failed', kind: 'chunk' })

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
  })

  it('sendBeacon вернул false → fetch с keepalive и тем же envelope', () => {
    const page = boot({}, { sendBeacon: () => false })

    page.dispatch({ reason: 'retry-failed', kind: 'entry', url: ENTRY_URL })

    expect(page.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = page.fetch.mock.calls[0] ?? []
    expect(url).toBe(TUNNEL)
    expect(init).toMatchObject({ method: 'POST', keepalive: true, body: page.sendBeacon.mock.calls[0]?.[1] })
    expect(parseEnvelope(String(init?.body)).payload.fingerprint).toEqual([
      'chunk-reload-blocked',
      'retry-failed',
      'entry',
    ])
  })
})
