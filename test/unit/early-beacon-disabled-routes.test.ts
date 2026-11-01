import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'

import { buildEarlyBeaconScript } from '../../src/runtime/utils/early-beacon'
import { createRouteMatcher } from '../../src/runtime/utils/route-patterns'
import { OPTIONS, UNSUPPORTED, beaconEnvelope, boot, type BootedPage } from './helpers/early-beacon-page'
import { NETWORK_DETAIL } from './helpers/load-timeout-details'

const SITE = 'https://kp.modmb.com'
const STAFF_PAGE = `${SITE}/admin/partners`
const RETRY_FAILED = { reason: 'retry-failed', kind: 'entry', url: 'https://cdn.pushka.biz/_nuxt/entry.DkQ1x.js' }
const DISABLED = ['/clients/**']

/* Все три исхода, которые умеет слать скрипт: unsupported-browser, retry-failed и watchdog. */
function dispatchEverything(page: BootedPage): void {
  page.dispatch(UNSUPPORTED)
  page.dispatch(RETRY_FAILED)
  page.dispatchLoadTimeout(NETWORK_DETAIL)
}

describe('ранний beacon: client.disabledRoutes — документ на отключённом пути', () => {
  it.each(['/clients', '/clients/', '/clients/ckx1a2b3c', '/clients/a/b'])(
    'путь %s: ни одного слушателя и ни одного запроса — ни для unsupported-browser, ни для retry-failed, ни для watchdog',
    (pathname) => {
      const page = boot({ disabledRoutes: DISABLED }, { href: `${SITE}${pathname}` })

      dispatchEverything(page)

      expect(page.listenerCount).toBe(0)
      expect(page.loadTimeoutListenerCount).toBe(0)
      expect(page.sendBeacon).not.toHaveBeenCalled()
      expect(page.fetch).not.toHaveBeenCalled()
    },
  )

  it('query и hash в решении не участвуют: публичная карточка с ?utm и #якорем остаётся отключённой', () => {
    const page = boot({ disabledRoutes: DISABLED }, { href: `${SITE}/clients/ckx1a2b3c?utm=mail&from=/admin#top` })

    dispatchEverything(page)

    expect(page.listenerCount).toBe(0)
    expect(page.sendBeacon).not.toHaveBeenCalled()
  })

  it('один из нескольких паттернов совпал — документ отключён', () => {
    const page = boot({ disabledRoutes: ['/share/*', '/clients/**'] }, { href: `${SITE}/clients/abc` })

    dispatchEverything(page)

    expect(page.sendBeacon).not.toHaveBeenCalled()
  })
})

describe('ранний beacon: client.disabledRoutes — любой другой документ работает как прежде', () => {
  it.each(['/', '/admin/partners', '/clientsx', '/client', '/x/clients/abc', '/Clients/abc'])(
    'путь %s: слушатели стоят, все три исхода уходят в tunnel',
    (pathname) => {
      const page = boot({ disabledRoutes: DISABLED }, { href: `${SITE}${pathname}` })

      expect(page.listenerCount).toBe(1)
      expect(page.loadTimeoutListenerCount).toBe(1)
      dispatchEverything(page)

      expect(page.sendBeacon).toHaveBeenCalledTimes(3)
    },
  )

  it('адрес с отключённым путём только в query или hash документ не отключает', () => {
    const page = boot({ disabledRoutes: DISABLED }, { href: `${STAFF_PAGE}?next=/clients/abc#/clients/x` })

    page.dispatch(UNSUPPORTED)

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
  })

  it('события те же, что без опции (кроме event_id и timestamp)', () => {
    const withOption = boot({ disabledRoutes: DISABLED }, { href: STAFF_PAGE })
    const without = boot({}, { href: STAFF_PAGE })

    for (const page of [withOption, without]) {
      dispatchEverything(page)
    }

    for (const index of [0, 1, 2]) {
      const { event_id: _a, timestamp: _b, ...expected } = beaconEnvelope(without, index).payload
      const { event_id: _c, timestamp: _d, ...actual } = beaconEnvelope(withOption, index).payload
      expect(actual).toEqual(expected)
    }
  })
})

describe('ранний beacon: client.disabledRoutes — решение совпадает с матчером плагина', () => {
  const PATTERN_SETS = [
    ['/clients/**'],
    ['/clients', '/share/*'],
    ['/a/*/c'],
    ['/**'],
    ['/v1.0/**', '/x(y)'],
    [String.raw`/a\b`],
    [],
  ]
  const PATHS = [
    '/',
    '/clients',
    '/clients/',
    '/clients/a',
    '/clients/a/b',
    '/clientsx',
    '/share/1',
    '/share',
    '/share/1/2',
    '/a/b/c',
    '/a/c',
    '/a/b/c/d',
    '/v1.0',
    '/v1.0/z',
    '/v1x0/z',
    '/x(y)',
    '/xy',
    String.raw`/a\b`,
    '/admin/partners',
  ]

  it('скрипт молчит ровно на тех путях, на которых createRouteMatcher отвечает true', () => {
    for (const patterns of PATTERN_SETS) {
      const matcher = createRouteMatcher(patterns)
      for (const pathname of PATHS) {
        const page = boot({ disabledRoutes: patterns }, { pathname })

        expect(page.listenerCount === 0, `${JSON.stringify(patterns)} ${pathname}`).toBe(matcher(pathname))
      }
    }
  })
})

describe('ранний beacon: client.disabledRoutes — порядок с гейтом localhost', () => {
  it.each([
    ['localhost, отключённый путь', 'localhost', '/clients/abc', false],
    ['localhost, обычный путь (гейт localhost, как прежде)', 'localhost', '/admin', false],
    ['обычный хост, отключённый путь', 'kp.modmb.com', '/clients/abc', false],
    ['обычный хост, обычный путь', 'kp.modmb.com', '/admin', true],
  ])('%s', (_name, hostname, pathname, sends) => {
    const page = boot({ disabledRoutes: DISABLED, excludeLocalhostInProd: true }, { hostname, pathname })

    page.dispatch(UNSUPPORTED)

    expect(page.sendBeacon.mock.calls.length === 1).toBe(sends)
  })

  it('excludeLocalhostInProd: false не включает отключённый путь обратно', () => {
    const page = boot(
      { disabledRoutes: DISABLED, excludeLocalhostInProd: false },
      { hostname: 'localhost', pathname: '/clients/abc' },
    )

    page.dispatch(UNSUPPORTED)

    expect(page.sendBeacon).not.toHaveBeenCalled()
  })
})

describe('ранний beacon: client.disabledRoutes — текст скрипта', () => {
  const BASE = buildEarlyBeaconScript(OPTIONS)
  /* Значения паттернов уезжают в inline-текст каждой страницы: `<`, U+2028/U+2029 и обратная косая не должны его ломать. */
  const HOSTILE = ['/a</script><!--/**', '/line\u2028sep\u2029', String.raw`/back\slash/*`]

  it('без опции, с undefined и с пустым списком текст скрипта один и тот же, без гейта и без RegExp', () => {
    expect(buildEarlyBeaconScript({ ...OPTIONS, disabledRoutes: undefined })).toBe(BASE)
    expect(buildEarlyBeaconScript({ ...OPTIONS, disabledRoutes: [] })).toBe(BASE)
    for (const marker of ['disabledRoutes', 'RegExp', 'pathname']) {
      expect(BASE, marker).not.toContain(marker)
    }
  })

  it.each([
    ['один паттерн', DISABLED],
    ['несколько паттернов', ['/clients/**', '/share/*', '/exact', '/v1.0/**']],
    ['враждебные значения', HOSTILE],
  ])('с опцией (%s) разбирается как ES5', (_name, disabledRoutes) => {
    const script = buildEarlyBeaconScript({ ...OPTIONS, disabledRoutes })

    expect(() => parse(script, { ecmaVersion: 5, sourceType: 'script' })).not.toThrow()
  })

  it('в inline-тексте нет закрывающего script и открывающего комментария, даже из паттернов', () => {
    const script = buildEarlyBeaconScript({ ...OPTIONS, disabledRoutes: HOSTILE })

    expect(script).not.toMatch(/<\/script/iu)
    expect(script).not.toContain('<!--')
  })

  it('гейт не добавляет в шаблон ни одного символа вне ASCII (скрипт уезжает в HTML каждой страницы)', () => {
    const nonAscii = /[^\n\u0020-\u007E]/gu

    expect(buildEarlyBeaconScript({ ...OPTIONS, disabledRoutes: DISABLED }).match(nonAscii)).toEqual(
      BASE.match(nonAscii),
    )
  })

  it('значения паттернов доезжают до RegExp без искажений: `<`, U+2028 и обратная косая — обычные символы пути', () => {
    function silent(patterns: string[], pathname: string): boolean {
      return boot({ disabledRoutes: patterns }, { pathname }).listenerCount === 0
    }

    expect(silent(['/a</script><!--/**'], '/a</script><!--/b')).toBe(true)
    expect(silent(['/a</script><!--/**'], '/a/b')).toBe(false)
    expect(silent(['/line\u2028sep'], '/line\u2028sep')).toBe(true)
    expect(silent(['/line\u2028sep'], '/linesep')).toBe(false)
    expect(silent([String.raw`/back\slash/*`], String.raw`/back\slash/x`)).toBe(true)
    expect(silent([String.raw`/back\slash/*`], '/back/slash/x')).toBe(false)
  })

  it('исполнение со списком не оставляет глобалов (всё в IIFE)', () => {
    const page = boot({ disabledRoutes: DISABLED }, { href: STAFF_PAGE })

    expect(Object.keys(page.context)).toEqual(['window'])
  })

  it('битый паттерн ломает сборку скрипта, а не отдаёт скрипт без гейта', () => {
    expect(() => buildEarlyBeaconScript({ ...OPTIONS, disabledRoutes: ['/a/**/b'] })).toThrow(/unsupported pattern/u)
  })
})
