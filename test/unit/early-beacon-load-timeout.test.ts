import type { Event } from '@sentry/core'
import { describe, expect, it } from 'vitest'

import { listenChunkReloadBlocked } from '../../src/runtime/utils/chunk-reload-report'
import { toLoadTimeoutEvent, type LoadTimeoutDetail } from '../../src/runtime/utils/load-timeout-report'
import { DSN, IPHONE_UA, PAGE, TUNNEL, beaconEnvelope, boot, parseEnvelope } from './helpers/early-beacon-page'
import {
  BOOT_DETAIL,
  BOOT_EVENT,
  ENTRY_CSS,
  ENTRY_JS,
  LEGACY_DETAIL,
  LEGACY_EVENT,
  NETWORK_DETAIL,
  NETWORK_EVENT,
  detailWith,
} from './helpers/load-timeout-details'

const DETAIL: LoadTimeoutDetail = {
  reason: 'load-timeout',
  timeoutMs: 45_000,
  elapsedMs: 45_123,
}

const ENTRY_URL = 'https://cdn.pushka.biz/_nuxt/entry.DkQ1x.js'

/* То, что событие берёт из detail и вшитого шаблона; остальное (request, release, sdk…) — поля браузера. */
function reportOf(
  event: Event | { message?: string; level?: string; fingerprint?: string[]; tags?: unknown; contexts?: unknown },
) {
  const { message, level, fingerprint, tags, contexts } = event
  return { message, level, fingerprint, tags, contexts }
}

function sentReport(detail: unknown) {
  const page = boot()
  page.dispatchLoadTimeout(detail)
  return reportOf(beaconEnvelope(page).payload)
}

/* Подставной таргет подписки: в Node у globalThis нет addEventListener. */
class FakeTarget {
  readonly listeners = new Map<string, (event: Event) => void>()

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, listener)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    if (this.listeners.get(type) === listener) {
      this.listeners.delete(type)
    }
  }

  dispatch(type: string, detail?: unknown): void {
    const listener = this.listeners.get(type)
    if (listener) {
      listener({ type, detail } as unknown as Event)
    }
  }
}

describe('ранний beacon: watchdog «приложение не загрузилось за N с»', () => {
  it('один вызов navigator.sendBeacon на tunnel, событие по контракту', () => {
    const page = boot()

    page.dispatchLoadTimeout(DETAIL)

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
    expect(page.sendBeacon.mock.calls[0]?.[0]).toBe(TUNNEL)
    expect(page.sendBeacon.mock.contexts[0]).toBe(page.navigator)
    expect(page.fetch).not.toHaveBeenCalled()
    const { header, item, payload } = beaconEnvelope(page)
    expect(header.dsn).toBe(DSN)
    expect(header.event_id).toBe(payload.event_id)
    expect(item).toEqual({ type: 'event' })
    expect(reportOf(payload)).toEqual({
      message: 'Приложение не загрузилось за 45 с',
      level: 'error',
      fingerprint: ['app-load-timeout'],
      tags: { 'load.timeoutMs': '45000', 'load.elapsedMs': '45123' },
      contexts: { load: { timeoutMs: 45_000, elapsedMs: 45_123 } },
    })
    expect(payload).toMatchObject({
      platform: 'javascript',
      request: { url: PAGE, headers: { 'User-Agent': IPHONE_UA } },
      environment: 'production',
      sdk: { name: 'nuxt-sentry.early-beacon', version: '0.10.0' },
    })
  })

  it('kind и url доезжают в тег и контекст', () => {
    expect(
      sentReport({ reason: 'load-timeout', timeoutMs: 45_000, elapsedMs: 45_000, kind: 'entry', url: ENTRY_URL }),
    ).toEqual({
      message: 'Приложение не загрузилось за 45 с',
      level: 'error',
      fingerprint: ['app-load-timeout'],
      tags: { 'load.timeoutMs': '45000', 'load.elapsedMs': '45000', 'load.kind': 'entry' },
      contexts: { load: { timeoutMs: 45_000, elapsedMs: 45_000, kind: 'entry', url: ENTRY_URL } },
    })
  })

  it('повторный watchdog — всё ещё одно событие (одно сообщение на документ)', () => {
    const page = boot()

    page.dispatchLoadTimeout(DETAIL)
    page.dispatchLoadTimeout({ reason: 'load-timeout', timeoutMs: 45_000, elapsedMs: 46_000 })

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
    expect(beaconEnvelope(page).payload.fingerprint).toEqual(['app-load-timeout'])
  })

  it('watchdog и chunk-событие — разные события: по одному envelope на каждое', () => {
    const page = boot()

    page.dispatchLoadTimeout(DETAIL)
    page.dispatch({ reason: 'retry-failed', kind: 'chunk' })

    expect(page.sendBeacon).toHaveBeenCalledTimes(2)
    expect(beaconEnvelope(page, 0).payload.fingerprint).toEqual(['app-load-timeout'])
    expect(beaconEnvelope(page, 1).payload.fingerprint).toEqual(['chunk-reload-blocked', 'retry-failed', 'chunk'])
  })

  it.each([
    ['detail без timeoutMs', { reason: 'load-timeout', elapsedMs: 45_123 }],
    ['timeoutMs не число', { reason: 'load-timeout', timeoutMs: '45000', elapsedMs: 45_123 }],
    ['timeoutMs ноль', { reason: 'load-timeout', timeoutMs: 0, elapsedMs: 45_123 }],
    ['timeoutMs NaN', { reason: 'load-timeout', timeoutMs: Number.NaN, elapsedMs: 45_123 }],
  ])('битый detail (%s): событие уходит, заголовок без числа', (_name, detail) => {
    const report = sentReport(detail)

    expect(report.message).toBe('Приложение не загрузилось')
    expect(report.level).toBe('error')
    expect(report.fingerprint).toEqual(['app-load-timeout'])
  })

  it.each([
    ['null', null],
    ['строка', 'load-timeout'],
    ['число', 42],
  ])('detail %s — ничего не шлёт и не тратит дедуп', (_name, detail) => {
    const page = boot()

    page.dispatchLoadTimeout(detail)

    expect(page.sendBeacon).not.toHaveBeenCalled()
    expect(page.fetch).not.toHaveBeenCalled()
    page.dispatchLoadTimeout(DETAIL)
    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
  })

  it('localhost при excludeLocalhostInProd — не отправляется', () => {
    const page = boot({ excludeLocalhostInProd: true }, { hostname: 'localhost' })

    page.dispatchLoadTimeout(DETAIL)

    expect(page.sendBeacon).not.toHaveBeenCalled()
    expect(page.fetch).not.toHaveBeenCalled()
  })

  it('sendBeacon вернул false → fetch с keepalive и тем же envelope', () => {
    const page = boot({}, { sendBeacon: () => false })

    page.dispatchLoadTimeout(DETAIL)

    expect(page.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = page.fetch.mock.calls[0] ?? []
    expect(url).toBe(TUNNEL)
    expect(init).toMatchObject({ method: 'POST', keepalive: true, body: page.sendBeacon.mock.calls[0]?.[1] })
    expect(parseEnvelope(String(init?.body)).payload.fingerprint).toEqual(['app-load-timeout'])
  })
})

describe('ранний beacon: watchdog со стадиями (guard ≥ 0.8.0)', () => {
  it('network: заголовок и fingerprint с хостом, теги диагностики и контекст со списками', () => {
    expect(sentReport(NETWORK_DETAIL)).toEqual(NETWORK_EVENT)
  })

  it('boot: заголовок и fingerprint без хоста, теги диагностики и контекст с ошибками', () => {
    expect(sentReport(BOOT_DETAIL)).toEqual(BOOT_EVENT)
  })

  it('detail guard 0.7.0 (без стадии): заголовок и fingerprint прежние, новых тегов нет', () => {
    expect(sentReport(LEGACY_DETAIL)).toEqual(LEGACY_EVENT)
  })

  it('network без host: unknown в заголовке и fingerprint, тега host нет', () => {
    const report = sentReport(detailWith(NETWORK_DETAIL, { host: undefined }))

    expect(report.message).toBe('Приложение не загрузилось за 30 с: не пришли ресурсы (unknown)')
    expect(report.fingerprint).toEqual(['app-load-timeout', 'network', 'unknown'])
    expect((report.tags as Record<string, string>)['load.host']).toBeUndefined()
  })

  it('общий заголовок без числа держит уточнение стадии', () => {
    expect(sentReport(detailWith(BOOT_DETAIL, { timeoutMs: Number.NaN })).message).toBe(
      'Приложение не загрузилось: сбой при старте',
    )
    expect(sentReport(detailWith(NETWORK_DETAIL, { timeoutMs: 0 })).message).toBe(
      'Приложение не загрузилось: не пришли ресурсы (fonts.googleapis.com)',
    )
  })

  it('один отчёт на документ: после network watchdog другой стадии не шлётся', () => {
    const page = boot()

    page.dispatchLoadTimeout(NETWORK_DETAIL)
    page.dispatchLoadTimeout(BOOT_DETAIL)

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
    expect(beaconEnvelope(page).payload.fingerprint).toEqual(NETWORK_EVENT.fingerprint)
  })

  it('отчёт со стадией уходит тем же envelope: заголовок с DSN, item event, поля браузера', () => {
    const page = boot()

    page.dispatchLoadTimeout(NETWORK_DETAIL)
    const { header, item, payload } = beaconEnvelope(page)

    expect(header.dsn).toBe(DSN)
    expect(header.event_id).toBe(payload.event_id)
    expect(item).toEqual({ type: 'event' })
    expect(payload).toMatchObject({
      platform: 'javascript',
      request: { url: PAGE, headers: { 'User-Agent': IPHONE_UA } },
      environment: 'production',
      sdk: { name: 'nuxt-sentry.early-beacon', version: '0.10.0' },
    })
  })
})

describe('ранний beacon: watchdog совпадает с SDK-мапингом на тех же данных', () => {
  it.each<[string, unknown]>([
    ['network: полный detail', NETWORK_DETAIL],
    ['boot: полный detail', BOOT_DETAIL],
    ['guard 0.7.0: полный detail', DETAIL],
    ['guard 0.7.0: с kind и url', LEGACY_DETAIL],
    ['guard 0.7.0: с kind chunk и url скрипта', { ...DETAIL, kind: 'chunk', url: ENTRY_URL }],
    ['без kind и url', { reason: 'load-timeout', timeoutMs: 45_000, elapsedMs: 45_000 }],
    ['дробный timeoutMs', { reason: 'load-timeout', timeoutMs: 45_500, elapsedMs: 45_500 }],
    ['timeoutMs ноль', { reason: 'load-timeout', timeoutMs: 0, elapsedMs: 45_123 }],
    ['timeoutMs не число', { reason: 'load-timeout', timeoutMs: '45000', elapsedMs: 45_123 }],
    ['без elapsedMs', { reason: 'load-timeout', timeoutMs: 45_000 }],
    ['неизвестный kind', { reason: 'load-timeout', timeoutMs: 45_000, elapsedMs: 45_000, kind: 'page' }],
    ['пустой url', { reason: 'load-timeout', timeoutMs: 45_000, elapsedMs: 45_000, url: '' }],
    [
      'длинный url',
      { reason: 'load-timeout', timeoutMs: 45_000, elapsedMs: 45_000, url: `${ENTRY_URL}?${'q'.repeat(3000)}` },
    ],
    ['network без host', detailWith(NETWORK_DETAIL, { host: undefined })],
    ['network: host из пробелов', detailWith(NETWORK_DETAIL, { host: ' \n\t ' })],
    ['network: host не строка', detailWith(NETWORK_DETAIL, { host: 42 })],
    ['network: host с пробелами и переводом строки', detailWith(NETWORK_DETAIL, { host: '  cdn.pushka.biz \n:8443 ' })],
    ['boot: host игнорируется', detailWith(BOOT_DETAIL, { host: 'cdn.pushka.biz' })],
    ['без стадии, но с диагностикой и host', detailWith(NETWORK_DETAIL, { stage: undefined })],
    ['неизвестная стадия', detailWith(NETWORK_DETAIL, { stage: 'weird' })],
    ['стадия другого регистра', detailWith(BOOT_DETAIL, { stage: 'Boot' })],
    ['network: timeoutMs не число', detailWith(NETWORK_DETAIL, { timeoutMs: '30000' })],
    ['boot: timeoutMs ноль', detailWith(BOOT_DETAIL, { timeoutMs: 0 })],
    ['network: kind chunk', detailWith(NETWORK_DETAIL, { kind: 'chunk' })],
    ['boot: неизвестный kind', detailWith(BOOT_DETAIL, { kind: 'page' })],
    [
      'все новые поля битые',
      detailWith(NETWORK_DETAIL, {
        visibleMs: '1',
        hiddenMs: Number.NaN,
        url: 7,
        readyState: false,
        online: 'yes',
        vueMounted: 'no',
        pending: 'x',
        pendingCount: Number.POSITIVE_INFINITY,
        criticalCount: [],
        errors: 'e',
      }),
    ],
    [
      'pending и errors: смешанные записи',
      detailWith(BOOT_DETAIL, {
        pending: [ENTRY_CSS, 42, null, { a: 1 }, ENTRY_JS],
        errors: [
          { message: 'first', source: `${ENTRY_JS}:1:2` },
          { message: 42, source: 'dropped.js:1:1' },
          'plain string',
          null,
          [],
          { source: 'no-message.js:1:1' },
          { message: 'broken source', source: 7 },
          { message: 'empty source', source: '' },
          { message: '' },
        ],
      }),
    ],
    ['pending и errors: не массивы', detailWith(BOOT_DETAIL, { pending: { length: 1, 0: ENTRY_CSS }, errors: null })],
    ['pending и errors: пустые', detailWith(NETWORK_DETAIL, { pending: [], errors: [] })],
    ['online false, vueMounted true', detailWith(BOOT_DETAIL, { online: false, vueMounted: true })],
    [
      'дробные, нулевые и отрицательные числа',
      detailWith(NETWORK_DETAIL, { visibleMs: 12.5, hiddenMs: -1, pendingCount: 0 }),
    ],
    ['readyState из пробелов', detailWith(BOOT_DETAIL, { readyState: '  ' })],
    [
      'длинные значения',
      detailWith(NETWORK_DETAIL, {
        host: 'h'.repeat(300),
        readyState: 'r'.repeat(300),
        url: `${ENTRY_URL}?${'q'.repeat(3000)}`,
        pending: ['p'.repeat(3000), ENTRY_CSS],
        errors: [{ message: 'm'.repeat(3000), source: 's'.repeat(3000) }],
      }),
    ],
    [
      'суррогатная пара на границах лимитов',
      detailWith(NETWORK_DETAIL, {
        host: `${'a'.repeat(199)}😀`,
        readyState: `${'r'.repeat(199)}😀`,
        pending: [`${'p'.repeat(1999)}😀`],
        errors: [{ message: `${'m'.repeat(1999)}😀`, source: `${'s'.repeat(1999)}😀` }],
      }),
    ],
  ])('detail: %s', (_name, detail) => {
    expect(sentReport(detail)).toEqual(reportOf(toLoadTimeoutEvent(detail as LoadTimeoutDetail)))
  })
})

describe('SDK-путь: watchdog не отправляется', () => {
  it('подписка SDK-пути — только на app:chunk-reload-blocked', () => {
    const target = new FakeTarget()
    const captured: Event[] = []

    listenChunkReloadBlocked((event) => {
      captured.push(event)
    }, target)

    expect([...target.listeners.keys()]).toEqual(['app:chunk-reload-blocked'])
  })

  it('событие app:load-timeout SDK-путь не отправляет (дубля не будет)', () => {
    const target = new FakeTarget()
    const captured: Event[] = []

    listenChunkReloadBlocked((event) => {
      captured.push(event)
    }, target)
    target.dispatch('app:load-timeout', DETAIL)

    expect(captured).toHaveLength(0)
  })

  it('событие app:chunk-reload-blocked SDK-путь по-прежнему отправляет', () => {
    const target = new FakeTarget()
    const captured: Event[] = []

    const stop = listenChunkReloadBlocked((event) => {
      captured.push(event)
    }, target)
    target.dispatch('app:chunk-reload-blocked', { reason: 'not-stale', buildId: 'b-1', probes: [] })

    expect(captured).toHaveLength(1)
    expect(captured[0]?.fingerprint).toEqual(['chunk-reload-blocked', 'not-stale'])

    stop()
    target.dispatch('app:chunk-reload-blocked', { reason: 'cooldown', buildId: 'b-2' })
    expect(captured).toHaveLength(1)
  })
})
