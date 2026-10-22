import type { Event } from '@sentry/core'
import { describe, expect, it } from 'vitest'

import {
  LOAD_TIMEOUT_EVENT,
  LOAD_TIMEOUT_FINGERPRINT,
  LOAD_TIMEOUT_MESSAGE_GENERIC,
  toLoadTimeoutEvent,
  type LoadTimeoutDetail,
} from '../../src/runtime/utils/load-timeout-report'

const DETAIL: LoadTimeoutDetail = {
  reason: 'load-timeout',
  timeoutMs: 45_000,
  elapsedMs: 45_123,
}

interface LoadContext {
  timeoutMs?: number
  elapsedMs?: number
  kind?: string
  url?: string
}

function loadContext(event: Event): LoadContext {
  return event.contexts?.load as LoadContext
}

describe('отчёт о watchdog-е: событие по detail', () => {
  it('имя события и fingerprint — контракт с guard', () => {
    expect(LOAD_TIMEOUT_EVENT).toBe('app:load-timeout')
    expect(LOAD_TIMEOUT_FINGERPRINT).toBe('app-load-timeout')
  })

  it('заголовок с числом секунд, level error, fingerprint, теги и контекст', () => {
    expect(toLoadTimeoutEvent(DETAIL)).toEqual({
      message: 'Приложение не загрузилось за 45 с',
      level: 'error',
      fingerprint: ['app-load-timeout'],
      tags: { 'load.timeoutMs': '45000', 'load.elapsedMs': '45123' },
      contexts: { load: { timeoutMs: 45_000, elapsedMs: 45_123 } },
    })
  })

  it('kind и url доезжают в тег и в контекст', () => {
    expect(
      toLoadTimeoutEvent({
        reason: 'load-timeout',
        timeoutMs: 45_000,
        elapsedMs: 45_000,
        kind: 'entry',
        url: 'https://cdn.pushka.biz/_nuxt/entry.DkQ1x.js',
      }),
    ).toEqual({
      message: 'Приложение не загрузилось за 45 с',
      level: 'error',
      fingerprint: ['app-load-timeout'],
      tags: { 'load.timeoutMs': '45000', 'load.elapsedMs': '45000', 'load.kind': 'entry' },
      contexts: {
        load: {
          timeoutMs: 45_000,
          elapsedMs: 45_000,
          kind: 'entry',
          url: 'https://cdn.pushka.biz/_nuxt/entry.DkQ1x.js',
        },
      },
    })
  })

  it('без kind и url — тега load.kind нет, в контексте только числа', () => {
    const event = toLoadTimeoutEvent(DETAIL)

    expect(event.tags?.['load.kind']).toBeUndefined()
    expect(loadContext(event)).toEqual({ timeoutMs: 45_000, elapsedMs: 45_123 })
  })

  it.each([
    ['нулевой timeout', 0],
    ['отрицательный timeout', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('timeoutMs %s — заголовок без числа, событие не теряется', (_name, timeoutMs) => {
    const event = toLoadTimeoutEvent({ reason: 'load-timeout', timeoutMs, elapsedMs: 45_123 })

    expect(event.message).toBe(LOAD_TIMEOUT_MESSAGE_GENERIC)
    expect(event.level).toBe('error')
    expect(event.fingerprint).toEqual(['app-load-timeout'])
  })

  it('timeoutMs не число — заголовок без числа', () => {
    const event = toLoadTimeoutEvent({
      reason: 'load-timeout',
      timeoutMs: '45000' as unknown as number,
      elapsedMs: 45_123,
    })

    expect(event.message).toBe(LOAD_TIMEOUT_MESSAGE_GENERIC)
    expect(event.tags?.['load.timeoutMs']).toBeUndefined()
    expect(loadContext(event)).toEqual({ elapsedMs: 45_123 })
  })

  it.each([
    ['44999 мс', 44_999, '45'],
    ['45500 мс', 45_500, '46'],
    ['1000 мс', 1_000, '1'],
    ['400 мс округляется до нуля', 400, '0'],
  ])('секунды округляются: %s', (_name, timeoutMs, seconds) => {
    expect(toLoadTimeoutEvent({ reason: 'load-timeout', timeoutMs, elapsedMs: timeoutMs }).message).toBe(
      `Приложение не загрузилось за ${seconds} с`,
    )
  })

  it('kind не из списка guard-а — игнорируется', () => {
    const event = toLoadTimeoutEvent({
      reason: 'load-timeout',
      timeoutMs: 45_000,
      elapsedMs: 45_000,
      kind: 'page' as LoadTimeoutDetail['kind'],
    })

    expect(event.tags?.['load.kind']).toBeUndefined()
    expect(loadContext(event)).toEqual({ timeoutMs: 45_000, elapsedMs: 45_000 })
  })

  it.each([
    ['пустая строка', ''],
    ['не строка', 42 as unknown as string],
  ])('url %s — в контекст не попадает', (_name, url) => {
    const event = toLoadTimeoutEvent({ reason: 'load-timeout', timeoutMs: 45_000, elapsedMs: 45_000, url })

    expect(loadContext(event)).toEqual({ timeoutMs: 45_000, elapsedMs: 45_000 })
  })

  it('длинный url обрезается до 2000 символов', () => {
    const url = `https://cdn.pushka.biz/_nuxt/entry.js?${'q'.repeat(3000)}`
    const event = toLoadTimeoutEvent({ reason: 'load-timeout', timeoutMs: 45_000, elapsedMs: 45_000, url })

    expect(loadContext(event).url).toHaveLength(2000)
  })
})
