import type { Event } from '@sentry/core'
import { describe, expect, it } from 'vitest'

import {
  LOAD_TIMEOUT_EVENT,
  LOAD_TIMEOUT_FINGERPRINT,
  LOAD_TIMEOUT_MESSAGE_GENERIC,
  toLoadTimeoutEvent,
  type LoadTimeoutDetail,
} from '../../src/runtime/utils/load-timeout-report'
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
  reportWithout,
} from './helpers/load-timeout-details'

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
  host?: string
  readyState?: string
  pending?: string[]
  errors?: { message: string; source?: string }[]
}

function loadContext(event: Event): LoadContext {
  return event.contexts?.load as LoadContext
}

describe('отчёт о watchdog-е: имя события и fingerprint — контракт с guard', () => {
  it('имя события и корень fingerprint', () => {
    expect(LOAD_TIMEOUT_EVENT).toBe('app:load-timeout')
    expect(LOAD_TIMEOUT_FINGERPRINT).toBe('app-load-timeout')
  })
})

describe('отчёт о watchdog-е: detail guard 0.7.0 (без стадии) — заголовок и fingerprint прежние', () => {
  it('detail guard 0.7.0 целиком: событие без уточнений и без новых тегов', () => {
    expect(toLoadTimeoutEvent(LEGACY_DETAIL)).toEqual(LEGACY_EVENT)
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

describe('отчёт о watchdog-е: стадия network — не пришли ресурсы (guard ≥ 0.8.0)', () => {
  it('заголовок с хостом, fingerprint с хостом, теги диагностики и контекст со списками', () => {
    expect(toLoadTimeoutEvent(NETWORK_DETAIL)).toEqual(NETWORK_EVENT)
  })

  it('kind доезжает вместе со стадией: тег и контекст, на заголовок и fingerprint не влияет', () => {
    const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { kind: 'entry' }))

    expect(event).toEqual({
      ...NETWORK_EVENT,
      tags: { ...NETWORK_EVENT.tags, 'load.kind': 'entry' },
      contexts: { load: { ...NETWORK_EVENT.contexts.load, kind: 'entry' } },
    })
  })

  it.each([
    ['поля нет', undefined],
    ['пустая строка', ''],
    ['пробелы и переводы строк', ' \n\t '],
    ['число', 42],
    ['null', null],
    ['объект', { host: 'cdn.pushka.biz' }],
  ])(
    'host без валидного значения (%s): unknown в заголовке и fingerprint, тега и контекста host нет',
    (_name, host) => {
      const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { host }))

      expect(event).toEqual({
        ...reportWithout(NETWORK_EVENT, 'host'),
        message: 'Приложение не загрузилось за 30 с: не пришли ресурсы (unknown)',
        fingerprint: ['app-load-timeout', 'network', 'unknown'],
      })
    },
  )

  it('host в заголовке и fingerprint — одной строкой без краёв', () => {
    const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { host: '  cdn.pushka.biz \n:8443 ' }))

    expect(event.message).toBe('Приложение не загрузилось за 30 с: не пришли ресурсы (cdn.pushka.biz :8443)')
    expect(event.fingerprint).toEqual(['app-load-timeout', 'network', 'cdn.pushka.biz :8443'])
    expect(event.tags?.['load.host']).toBe('cdn.pushka.biz :8443')
  })

  it('общий заголовок без числа: timeoutMs не положительное конечное число, уточнение стадии остаётся', () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '30000', null, undefined]) {
      const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { timeoutMs }))

      expect(event.message).toBe('Приложение не загрузилось: не пришли ресурсы (fonts.googleapis.com)')
      expect(event.fingerprint).toEqual(['app-load-timeout', 'network', 'fonts.googleapis.com'])
    }
  })

  it('группировка: делят issue только стадия и хост — время, url, списки и состояние документа не влияют', () => {
    const base = toLoadTimeoutEvent(NETWORK_DETAIL)
    const sameHost = toLoadTimeoutEvent(
      detailWith(NETWORK_DETAIL, {
        visibleMs: 31_000,
        hiddenMs: 0,
        elapsedMs: 31_000,
        url: 'https://kp.modmb.com/login',
        readyState: 'interactive',
        online: false,
        pending: ['fonts.googleapis.com/css2'],
        pendingCount: 1,
        errors: [{ message: 'boom' }],
      }),
    )
    const otherHost = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { host: 'cdn.pushka.biz' }))

    expect(sameHost.message).toBe(base.message)
    expect(sameHost.fingerprint).toEqual(base.fingerprint)
    expect(otherHost.message).toBe('Приложение не загрузилось за 30 с: не пришли ресурсы (cdn.pushka.biz)')
    expect(otherHost.fingerprint).toEqual(['app-load-timeout', 'network', 'cdn.pushka.biz'])
    expect(toLoadTimeoutEvent(BOOT_DETAIL).fingerprint).not.toEqual(base.fingerprint)
  })
})

describe('отчёт о watchdog-е: стадия boot — сбой при старте (guard ≥ 0.8.0)', () => {
  it('заголовок без хоста, fingerprint без хоста, теги диагностики и контекст с ошибками', () => {
    expect(toLoadTimeoutEvent(BOOT_DETAIL)).toEqual(BOOT_EVENT)
  })

  it('Vue смонтирован, а guard не узнал (vueMounted): тег и контекст', () => {
    const event = toLoadTimeoutEvent(detailWith(BOOT_DETAIL, { vueMounted: true }))

    expect(event.tags?.['load.vueMounted']).toBe('true')
    expect(loadContext(event)).toMatchObject({ vueMounted: true })
  })

  it('host у boot игнорируется: ни в заголовке, ни в fingerprint, ни в теге, ни в контексте', () => {
    expect(toLoadTimeoutEvent(detailWith(BOOT_DETAIL, { host: 'cdn.pushka.biz' }))).toEqual(BOOT_EVENT)
  })

  it('общий заголовок без числа: уточнение стадии остаётся', () => {
    const event = toLoadTimeoutEvent(detailWith(BOOT_DETAIL, { timeoutMs: Number.NaN }))

    expect(event.message).toBe('Приложение не загрузилось: сбой при старте')
    expect(event.fingerprint).toEqual(['app-load-timeout', 'boot'])
  })
})

describe('отчёт о watchdog-е: без валидной стадии — как у guard 0.7.0', () => {
  it.each([
    ['поля нет', undefined],
    ['неизвестное значение', 'weird'],
    ['другой регистр', 'Network'],
    ['число', 1],
    ['null', null],
    ['объект', { stage: 'boot' }],
  ])('stage (%s): заголовок и fingerprint без стадии и хоста, остальные валидные поля на месте', (_name, stage) => {
    const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { stage }))

    expect(event).toEqual({
      ...reportWithout(reportWithout(NETWORK_EVENT, 'stage'), 'host'),
      message: 'Приложение не загрузилось за 30 с',
      fingerprint: ['app-load-timeout'],
    })
  })
})

describe('отчёт о watchdog-е: поля detail проверяются независимо', () => {
  it.each<[string, string, unknown]>([
    ['visibleMs', 'строка', '30002'],
    ['visibleMs', 'NaN', Number.NaN],
    ['hiddenMs', 'Infinity', Number.POSITIVE_INFINITY],
    ['elapsedMs', 'null', null],
    ['url', 'число', 42],
    ['url', 'пустая строка', ''],
    ['readyState', 'число', 5],
    ['readyState', 'пробелы', ' \n '],
    ['online', 'строка', 'true'],
    ['online', 'число', 1],
    ['vueMounted', 'ноль', 0],
    ['vueMounted', 'строка', 'false'],
    ['pendingCount', 'строка', '2'],
    ['pendingCount', 'NaN', Number.NaN],
    ['criticalCount', 'null', null],
    ['pending', 'строка', 'fonts.googleapis.com/css2'],
    ['pending', 'массивоподобный объект', { 0: ENTRY_CSS, length: 1 }],
    ['errors', 'объект', { message: 'boom' }],
    ['errors', 'строка', 'boom'],
  ])('%s (%s) — битое поле пропускается, остальной отчёт цел', (key, _name, value) => {
    const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { [key]: value }))

    expect(event).toEqual(reportWithout(NETWORK_EVENT, key))
  })

  it('все новые поля сразу битые — остаётся отчёт по stage и host, событие не теряется', () => {
    const event = toLoadTimeoutEvent(
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
    )

    expect(event).toEqual({
      ...NETWORK_EVENT,
      tags: {
        'load.timeoutMs': '30000',
        'load.elapsedMs': '34102',
        'load.stage': 'network',
        'load.host': 'fonts.googleapis.com',
      },
      contexts: {
        load: {
          timeoutMs: 30_000,
          elapsedMs: 34_102,
          stage: 'network',
          host: 'fonts.googleapis.com',
        },
      },
    })
  })

  it('pending: не строки отбрасываются поштучно, pendingCount не пересчитывается', () => {
    const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { pending: [ENTRY_CSS, 42, null, { a: 1 }, ENTRY_JS] }))

    expect(loadContext(event).pending).toEqual([ENTRY_CSS, ENTRY_JS])
    expect(event.tags?.['load.pendingCount']).toBe('2')
  })

  it('errors: запись без строкового message отбрасывается, битый source — только он', () => {
    const event = toLoadTimeoutEvent(
      detailWith(BOOT_DETAIL, {
        errors: [
          { message: 'first', source: `${ENTRY_JS}:1:2` },
          { message: 42, source: 'dropped.js:1:1' },
          'plain string',
          null,
          { source: 'no-message.js:1:1' },
          { message: 'broken source', source: 7 },
          { message: 'empty source', source: '' },
          { message: '' },
        ],
      }),
    )

    expect(loadContext(event).errors).toEqual([
      { message: 'first', source: `${ENTRY_JS}:1:2` },
      { message: 'broken source' },
      { message: 'empty source' },
      { message: '' },
    ])
  })

  it('пустые pending и errors остаются в контексте пустыми массивами', () => {
    const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { pending: [], errors: [] }))

    expect(loadContext(event).pending).toEqual([])
    expect(loadContext(event).errors).toEqual([])
  })
})

describe('отчёт о watchdog-е: лимиты длины', () => {
  const LONG_HOST = 'h'.repeat(300)

  it('теги, заголовок и fingerprint — до 200 символов, контекст — до 2000', () => {
    const event = toLoadTimeoutEvent(
      detailWith(NETWORK_DETAIL, {
        host: LONG_HOST,
        readyState: 'r'.repeat(300),
        url: `https://kp.modmb.com/?${'q'.repeat(3000)}`,
        pending: ['p'.repeat(3000), ENTRY_CSS],
        errors: [{ message: 'm'.repeat(3000), source: 's'.repeat(3000) }],
      }),
    )
    const load = loadContext(event)

    expect(event.message).toBe(`Приложение не загрузилось за 30 с: не пришли ресурсы (${'h'.repeat(200)})`)
    expect(event.fingerprint).toEqual(['app-load-timeout', 'network', 'h'.repeat(200)])
    expect(event.tags?.['load.host']).toBe('h'.repeat(200))
    expect(event.tags?.['load.readyState']).toBe('r'.repeat(200))
    expect(load.host).toBe(LONG_HOST)
    expect(load.readyState).toBe('r'.repeat(300))
    expect(load.url).toHaveLength(2000)
    expect(load.pending?.map((item) => item.length)).toEqual([2000, ENTRY_CSS.length])
    expect(load.errors).toEqual([{ message: 'm'.repeat(2000), source: 's'.repeat(2000) }])
  })

  it('контекст host и readyState режется на лимите контекста', () => {
    const event = toLoadTimeoutEvent(
      detailWith(NETWORK_DETAIL, { host: 'h'.repeat(2500), readyState: 'r'.repeat(2500) }),
    )

    expect(loadContext(event).host).toHaveLength(2000)
    expect(loadContext(event).readyState).toHaveLength(2000)
  })

  it('обрезка не оставляет половину суррогатной пары', () => {
    const host = `${'a'.repeat(199)}😀`
    const event = toLoadTimeoutEvent(detailWith(NETWORK_DETAIL, { host, pending: [`${'p'.repeat(1999)}😀`] }))

    expect(event.tags?.['load.host']).toBe('a'.repeat(199))
    expect(event.fingerprint?.[2]).toBe('a'.repeat(199))
    expect(loadContext(event).pending).toEqual(['p'.repeat(1999)])
  })
})
