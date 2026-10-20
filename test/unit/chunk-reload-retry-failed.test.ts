import type { Event } from '@sentry/core'
import { describe, expect, it, vi } from 'vitest'

import {
  RETRY_FAILED_KINDS,
  createChunkReloadBlockedReporter,
  isChunkReloadBlockedDetail,
  toChunkReloadBlockedEvent,
  type ChunkReloadBlockedDetail,
} from '../../src/runtime/utils/chunk-reload-report'

const TITLE = 'Страница не загрузилась и после перезагрузки'
const CHUNK_MESSAGE = 'Failed to fetch dynamically imported module: https://cdn.pushka.biz/_nuxt/Dxf3k1.js'
const ENTRY_URL = 'https://cdn.pushka.biz/_nuxt/entry.DkQ1x.js'

function makeError(message = CHUNK_MESSAGE): TypeError {
  const error = new TypeError(message)
  error.stack = `TypeError: ${message}\n    at loadChunk (${ENTRY_URL}:1:2)`
  return error
}

describe('toChunkReloadBlockedEvent: retry-failed', () => {
  it('kind chunk с ошибкой → error, fingerprint с kind, теги reason/kind/error, ошибка в контексте', () => {
    const error = makeError()

    expect(toChunkReloadBlockedEvent({ reason: 'retry-failed', kind: 'chunk', error })).toEqual({
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
  })

  it('kind entry с адресом скрипта и без ошибки → url в контексте, тега chunk.error нет', () => {
    expect(toChunkReloadBlockedEvent({ reason: 'retry-failed', kind: 'entry', url: ENTRY_URL })).toEqual({
      message: TITLE,
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'retry-failed', 'entry'],
      tags: { 'chunk.reason': 'retry-failed', 'chunk.kind': 'entry' },
      contexts: { chunk: { reason: 'retry-failed', kind: 'entry', url: ENTRY_URL } },
    })
  })

  it('kind entry с ошибкой и адресом → оба поля в событии', () => {
    const event = toChunkReloadBlockedEvent({
      reason: 'retry-failed',
      kind: 'entry',
      error: 'Importing a module script failed.',
      url: ENTRY_URL,
    })

    expect(event.tags).toEqual({
      'chunk.reason': 'retry-failed',
      'chunk.kind': 'entry',
      'chunk.error': 'Importing a module script failed.',
    })
    expect(event.contexts?.chunk).toEqual({
      reason: 'retry-failed',
      kind: 'entry',
      error: { message: 'Importing a module script failed.' },
      url: ENTRY_URL,
    })
  })

  it.each(RETRY_FAILED_KINDS)('kind %s без error и url → только reason и kind', (kind) => {
    expect(toChunkReloadBlockedEvent({ reason: 'retry-failed', kind })).toEqual({
      message: TITLE,
      level: 'error',
      fingerprint: ['chunk-reload-blocked', 'retry-failed', kind],
      tags: { 'chunk.reason': 'retry-failed', 'chunk.kind': kind },
      contexts: { chunk: { reason: 'retry-failed', kind } },
    })
  })

  it('исходная ошибка не exception и не cause (текст матчится ignoreErrors) — как у остальных причин', () => {
    const event = toChunkReloadBlockedEvent({ reason: 'retry-failed', kind: 'chunk', error: makeError() })

    expect(Object.keys(event).toSorted()).toEqual(['contexts', 'fingerprint', 'level', 'message', 'tags'])
  })

  it('сообщение ошибки в теге: одна строка, не длиннее 200; в контексте — целиком', () => {
    const message = `${'Failed to fetch\n  dynamically imported module '.repeat(10)}end`
    const event = toChunkReloadBlockedEvent({ reason: 'retry-failed', kind: 'chunk', error: makeError(message) })

    expect(event.tags?.['chunk.error']).toBe(message.replaceAll(/\s+/gu, ' ').slice(0, 200))
    expect(event.contexts?.chunk).toMatchObject({ error: { message } })
  })

  /* Невалидный url — поле чужой ревизии guard с неверным типом: каст нужен, чтобы подать его в типизированный вход. */
  it.each([
    ['пустая строка', ''],
    ['не строка', 42],
    ['объект', { href: ENTRY_URL }],
  ])('url: %s не попадает в контекст', (_name, url) => {
    const detail = { reason: 'retry-failed', kind: 'entry', url } as unknown as ChunkReloadBlockedDetail

    expect(toChunkReloadBlockedEvent(detail).contexts?.chunk).toEqual({ reason: 'retry-failed', kind: 'entry' })
  })

  it('длинный url обрезается до 2000 без половины суррогатной пары', () => {
    const url = `${'u'.repeat(1999)}😀tail`

    const event = toChunkReloadBlockedEvent({ reason: 'retry-failed', kind: 'entry', url })

    expect(event.contexts?.chunk).toEqual({ reason: 'retry-failed', kind: 'entry', url: 'u'.repeat(1999) })
  })
})

describe('isChunkReloadBlockedDetail: kind у retry-failed', () => {
  it.each(RETRY_FAILED_KINDS)('kind %s принимается — и с error/url, и без них', (kind) => {
    expect(isChunkReloadBlockedDetail({ reason: 'retry-failed', kind })).toBe(true)
    expect(isChunkReloadBlockedDetail({ reason: 'retry-failed', kind, error: 'e', url: ENTRY_URL })).toBe(true)
  })

  it.each([
    ['без kind', { reason: 'retry-failed' }],
    ['неизвестный kind', { reason: 'retry-failed', kind: 'page' }],
    ['kind не строка', { reason: 'retry-failed', kind: 42 }],
    ['kind null', { reason: 'retry-failed', kind: null }],
    ['kind — массив с валидным значением', { reason: 'retry-failed', kind: ['chunk'] }],
    ['kind в другом регистре', { reason: 'retry-failed', kind: 'Chunk' }],
    ['kind из прототипа Object', { reason: 'retry-failed', kind: 'constructor' }],
  ])('%s отвергается', (_name, detail) => {
    expect(isChunkReloadBlockedDetail(detail)).toBe(false)
  })

  it('kind других причин не проверяется (у них его нет)', () => {
    expect(isChunkReloadBlockedDetail({ reason: 'no-build-id' })).toBe(true)
    expect(isChunkReloadBlockedDetail({ reason: 'cooldown', buildId: 'b', kind: 'whatever' })).toBe(true)
  })
})

describe('createChunkReloadBlockedReporter: retry-failed', () => {
  it.each(RETRY_FAILED_KINDS)('kind %s игнорируется: его шлёт только ранний beacon (иначе дубль)', (kind) => {
    const capture = vi.fn<(event: Event) => void>()
    const report = createChunkReloadBlockedReporter(capture)

    report({ reason: 'retry-failed', kind, error: makeError(), url: ENTRY_URL })

    expect(capture).not.toHaveBeenCalled()
  })

  it('не мешает остальным причинам: они по-прежнему уходят, по одной на reason', () => {
    const capture = vi.fn<(event: Event) => void>()
    const report = createChunkReloadBlockedReporter(capture)

    report({ reason: 'retry-failed', kind: 'chunk' })
    report({ reason: 'no-build-id', error: makeError() })
    report({ reason: 'retry-failed', kind: 'entry' })
    report({ reason: 'no-build-id', error: makeError() })

    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.calls[0]?.[0].tags?.['chunk.reason']).toBe('no-build-id')
  })
})
