import vm from 'node:vm'

import { parse } from 'acorn'
import { describe, expect, it, vi, type Mock } from 'vitest'

import { toChunkReloadBlockedEvent } from '../../src/runtime/utils/chunk-reload-report'
import { buildEarlyBeaconScript, type EarlyBeaconOptions } from '../../src/runtime/utils/early-beacon'
import { LOCAL_HOSTS, shouldEnableClientSentry } from '../../src/runtime/utils/sentry-enabled'

const DSN = 'https://cb4e0da9f40eb6fa331bb26592b64bd1@o4510084335534080.ingest.de.sentry.io/4511188847820880'
const TUNNEL = '/api/sentry-tunnel'
const PAGE = 'https://ai.pushka.biz/invite/abc123'
/* UA из инцидента ai.pushka.biz 15.10.2026: iOS 16.0.2 — WebKit без import maps. */
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

const OPTIONS: EarlyBeaconOptions = {
  dsn: DSN,
  tunnelEndpoint: TUNNEL,
  release: 'a1b2c3d',
  excludeLocalhostInProd: true,
  version: '0.10.0',
}

const UNSUPPORTED = { reason: 'unsupported-browser', missing: 'importmap' }

interface Envelope {
  header: { event_id: string; sent_at: string; dsn: string }
  item: { type: string }
  payload: Record<string, unknown> & { event_id: string; timestamp: number }
}

type BeaconFn = (url: string, body: string) => boolean
type FetchFn = (url: string, init: Record<string, unknown>) => Promise<unknown>
type WindowListener = (event: { type: string; detail?: unknown }) => void

/* Окружение страницы: ровно то, что скрипт берёт у `window`. null — API в браузере отсутствует. */
interface PageEnv {
  hostname?: string
  href?: string
  sendBeacon?: BeaconFn | null
  fetch?: FetchFn | null
  crypto?: null
}

interface BootedPage {
  context: object
  navigator: Record<string, unknown>
  sendBeacon: Mock<BeaconFn>
  fetch: Mock<FetchFn>
  listenerCount: number
  dispatch: (detail: unknown) => void
}

/*
 * Исполняет итоговый текст скрипта в отдельном vm-контексте, где глобал один — фейковый `window`.
 * Любое обращение к голому `navigator`/`location`/`fetch` дало бы ReferenceError, а не молча взяло
 * бы значение хоста; в рантайме браузера скрипт делает то же самое — читает только `window`.
 */
function boot(options: Partial<EarlyBeaconOptions> = {}, env: PageEnv = {}): BootedPage {
  const script = buildEarlyBeaconScript({ ...OPTIONS, ...options })
  const listeners: WindowListener[] = []
  const sendBeacon = vi.fn<BeaconFn>(env.sendBeacon ?? (() => true))
  const fetchSpy = vi.fn<FetchFn>(env.fetch ?? (() => Promise.resolve({ ok: true })))
  const navigator: Record<string, unknown> = { userAgent: IPHONE_UA }
  if (env.sendBeacon !== null) {
    navigator.sendBeacon = sendBeacon
  }
  const win: Record<string, unknown> = {
    navigator,
    location: { hostname: env.hostname ?? 'ai.pushka.biz', href: env.href ?? PAGE },
    addEventListener(type: string, listener: WindowListener) {
      if (type === 'app:chunk-reload-blocked') {
        listeners.push(listener)
      }
    },
  }
  if (env.fetch !== null) {
    win.fetch = fetchSpy
  }
  if (env.crypto !== null) {
    win.crypto = globalThis.crypto
  }
  const context = vm.createContext({ window: win })
  vm.runInContext(script, context)

  return {
    context,
    navigator,
    sendBeacon,
    fetch: fetchSpy,
    listenerCount: listeners.length,
    dispatch(detail) {
      for (const listener of listeners) {
        listener({ type: 'app:chunk-reload-blocked', detail })
      }
    },
  }
}

function parseEnvelope(body: string): Envelope {
  const lines = body.split('\n')
  expect(lines).toHaveLength(3)
  const [header, item, payload] = lines.map((line) => JSON.parse(line) as unknown)
  return { header, item, payload } as Envelope
}

function beaconEnvelope(page: BootedPage): Envelope {
  return parseEnvelope(String(page.sendBeacon.mock.calls[0]?.[1]))
}

describe('ранний beacon: unsupported-browser', () => {
  it('один вызов navigator.sendBeacon на tunnel (метод navigator, fetch не нужен)', () => {
    const page = boot()

    page.dispatch(UNSUPPORTED)

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
    expect(page.sendBeacon.mock.calls[0]?.[0]).toBe(TUNNEL)
    expect(page.sendBeacon.mock.contexts[0]).toBe(page.navigator)
    expect(page.fetch).not.toHaveBeenCalled()
  })

  it('envelope: заголовок с DSN, item event, событие по контракту', () => {
    const page = boot()

    page.dispatch(UNSUPPORTED)
    const { header, item, payload } = beaconEnvelope(page)

    expect(Object.keys(header).toSorted()).toEqual(['dsn', 'event_id', 'sent_at'])
    expect(header.dsn).toBe(DSN)
    expect(header.event_id).toBe(payload.event_id)
    expect(new Date(header.sent_at).toISOString()).toBe(header.sent_at)
    expect(item).toEqual({ type: 'event' })
    expect(payload).toMatchObject({
      platform: 'javascript',
      level: 'warning',
      message: 'Браузер без import maps',
      fingerprint: ['chunk-reload-blocked', 'unsupported-browser'],
      tags: { 'chunk.reason': 'unsupported-browser', 'chunk.missing': 'importmap' },
      contexts: { chunk: { reason: 'unsupported-browser' } },
      request: { url: PAGE, headers: { 'User-Agent': IPHONE_UA } },
      release: 'a1b2c3d',
      environment: 'production',
      sdk: { name: 'nuxt-sentry.early-beacon', version: '0.10.0' },
    })
    expect(Math.abs(payload.timestamp - Date.now() / 1000)).toBeLessThan(5)
  })

  it('вид события тот же, что у SDK-пути (общий шаблон)', () => {
    const page = boot()

    page.dispatch(UNSUPPORTED)

    expect(beaconEnvelope(page).payload).toMatchObject(
      toChunkReloadBlockedEvent({ reason: 'unsupported-browser', missing: 'importmap' }),
    )
  })

  it('release не задан → в событии нет поля release', () => {
    const page = boot({ release: undefined })

    page.dispatch(UNSUPPORTED)

    expect(beaconEnvelope(page).payload).not.toHaveProperty('release')
  })

  it('event_id: 32 hex в формате UUID v4, у каждой страницы свой', () => {
    const ids = [boot(), boot()].map((page) => {
      page.dispatch(UNSUPPORTED)
      return beaconEnvelope(page).payload.event_id
    })

    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/u)
    }
    expect(ids[0]).not.toBe(ids[1])
  })

  it('без crypto (старый WebView) event_id всё равно валиден', () => {
    const page = boot({}, { crypto: null })

    page.dispatch(UNSUPPORTED)

    expect(beaconEnvelope(page).payload.event_id).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/u)
  })

  it('повторный dispatch (в том числе после чужого reason) — всё ещё одно событие', () => {
    const page = boot()

    page.dispatch(UNSUPPORTED)
    page.dispatch({ reason: 'cooldown', buildId: 'b' })
    page.dispatch(UNSUPPORTED)

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
  })
})

describe('ранний beacon: что игнорируется', () => {
  it.each(['not-stale', 'circuit-breaker', 'cooldown', 'no-build-id'])(
    'reason %s — ни sendBeacon, ни fetch (приложение живо, отчёт шлёт плагин)',
    (reason) => {
      const page = boot()

      page.dispatch({
        reason,
        error: new Error('Failed to fetch dynamically imported module'),
        probes: [],
        buildId: 'b',
      })

      expect(page.sendBeacon).not.toHaveBeenCalled()
      expect(page.fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['без detail', undefined],
    ['detail null', null],
    ['пустой объект', {}],
    ['строка', 'unsupported-browser'],
    ['неизвестный reason', { reason: 'brand-new-reason' }],
  ])('мусорный detail (%s) не бросает и ничего не шлёт', (_name, detail) => {
    const page = boot()

    expect(() => {
      page.dispatch(detail)
    }).not.toThrow()

    expect(page.sendBeacon).not.toHaveBeenCalled()
    expect(page.fetch).not.toHaveBeenCalled()
  })

  it('сам по себе (без события) скрипт ничего не шлёт и ставит ровно один слушатель', () => {
    const page = boot()

    expect(page.listenerCount).toBe(1)
    expect(page.sendBeacon).not.toHaveBeenCalled()
  })
})

describe('ранний beacon: гейт localhost (как у клиентского SDK)', () => {
  it.each([...LOCAL_HOSTS])('%s при excludeLocalhostInProd — ничего не отправляется', (hostname) => {
    const page = boot({ excludeLocalhostInProd: true }, { hostname })

    page.dispatch(UNSUPPORTED)

    expect(page.sendBeacon).not.toHaveBeenCalled()
    expect(page.fetch).not.toHaveBeenCalled()
  })

  it.each([...LOCAL_HOSTS])('%s при excludeLocalhostInProd: false — отправляется (опт-аут гейта)', (hostname) => {
    const page = boot({ excludeLocalhostInProd: false }, { hostname })

    page.dispatch(UNSUPPORTED)

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
  })

  it('решение совпадает с shouldEnableClientSentry на любом хосте', () => {
    const hostnames = [
      ...LOCAL_HOSTS,
      'ai.pushka.biz',
      'example.com',
      '192.168.1.5',
      'localhost.example.com',
      'LOCALHOST',
    ]
    for (const hostname of hostnames) {
      for (const excludeLocalhost of [true, false]) {
        const page = boot({ excludeLocalhostInProd: excludeLocalhost }, { hostname })
        page.dispatch(UNSUPPORTED)
        expect(page.sendBeacon.mock.calls.length === 1, `${hostname} exclude=${excludeLocalhost}`).toBe(
          shouldEnableClientSentry({ isProd: true, hostname, excludeLocalhost }),
        )
      }
    }
  })
})

describe('ранний beacon: доставка', () => {
  it('нет navigator.sendBeacon → fetch с keepalive и тем же envelope', () => {
    const page = boot({}, { sendBeacon: null })

    page.dispatch(UNSUPPORTED)

    expect(page.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = page.fetch.mock.calls[0] ?? []
    expect(url).toBe(TUNNEL)
    expect(init).toMatchObject({ method: 'POST', keepalive: true })
    expect(parseEnvelope(String(init?.body)).header.dsn).toBe(DSN)
  })

  it('sendBeacon вернул false (очередь отклонена) → fetch с тем же телом', () => {
    const page = boot({}, { sendBeacon: () => false })

    page.dispatch(UNSUPPORTED)

    expect(page.sendBeacon).toHaveBeenCalledTimes(1)
    expect(page.fetch).toHaveBeenCalledTimes(1)
    expect(page.fetch.mock.calls[0]?.[1]).toMatchObject({ body: page.sendBeacon.mock.calls[0]?.[1], keepalive: true })
  })

  it('sendBeacon бросил → fetch', () => {
    const page = boot(
      {},
      {
        sendBeacon: () => {
          throw new Error('Illegal invocation')
        },
      },
    )

    expect(() => {
      page.dispatch(UNSUPPORTED)
    }).not.toThrow()

    expect(page.fetch).toHaveBeenCalledTimes(1)
  })

  it('результат fetch обрабатывается и на успех, и на отказ (иначе офлайн даёт unhandledrejection)', () => {
    const then = vi.fn()
    /* Настоящий Promise vi.fn() сам обходит через .then для settledResults — считать пришлось бы и чужие вызовы. */
    // oxlint-disable-next-line unicorn/no-thenable -- thenable-заглушка и есть предмет проверки
    const pending = { then } as unknown as Promise<unknown>
    const page = boot({}, { sendBeacon: null, fetch: () => pending })

    page.dispatch(UNSUPPORTED)

    expect(then).toHaveBeenCalledTimes(1)
    expect(then.mock.calls[0]?.map((handler: unknown) => typeof handler)).toEqual(['function', 'function'])
  })

  it('fetch бросил синхронно, а sendBeacon нет → не бросает наружу', () => {
    const page = boot(
      {},
      {
        sendBeacon: null,
        fetch: () => {
          throw new Error('keepalive unsupported')
        },
      },
    )

    expect(() => {
      page.dispatch(UNSUPPORTED)
    }).not.toThrow()
  })

  it('нет ни sendBeacon, ни fetch → тихо', () => {
    const page = boot({}, { sendBeacon: null, fetch: null })

    expect(() => {
      page.dispatch(UNSUPPORTED)
    }).not.toThrow()
  })
})

describe('ранний beacon: текст скрипта', () => {
  const HOSTILE: EarlyBeaconOptions = {
    dsn: 'https://k@h.example/1?x=</script><!--',
    tunnelEndpoint: '/t/$&$1"\'\\',
    release: 'r</SCRIPT>\u2028\u2029-->`$`',
    excludeLocalhostInProd: false,
    version: '1.0.0-rc.1',
  }

  it.each([
    ['обычные опции', OPTIONS],
    ['без release, без гейта localhost', { ...OPTIONS, release: undefined, excludeLocalhostInProd: false }],
    ['враждебные строки в конфиге', HOSTILE],
  ])('разбирается как ES5 (%s)', (_name, options) => {
    const script = buildEarlyBeaconScript(options)

    expect(() => parse(script, { ecmaVersion: 5, sourceType: 'script' })).not.toThrow()
  })

  it('в inline-тексте не бывает закрывающего script и открывающего комментария, даже из значений конфига', () => {
    const script = buildEarlyBeaconScript(HOSTILE)

    expect(script).not.toMatch(/<\/script/iu)
    expect(script).not.toContain('<!--')
  })

  it('значения конфига с </script>, $&, кавычками и U+2028 доезжают до события без искажений', () => {
    const page = boot(HOSTILE, { hostname: 'ai.pushka.biz' })

    page.dispatch(UNSUPPORTED)
    const { header, payload } = beaconEnvelope(page)

    expect(page.sendBeacon.mock.calls[0]?.[0]).toBe(HOSTILE.tunnelEndpoint)
    expect(header.dsn).toBe(HOSTILE.dsn)
    expect(payload.release).toBe(HOSTILE.release)
    expect((payload.sdk as { version: string }).version).toBe(HOSTILE.version)
  })

  it('исполнение не оставляет глобалов (всё в IIFE)', () => {
    const page = boot()

    expect(Object.keys(page.context)).toEqual(['window'])
  })
})
