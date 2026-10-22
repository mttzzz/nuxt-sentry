import vm from 'node:vm'

import { expect, vi, type Mock } from 'vitest'

import { buildEarlyBeaconScript, type EarlyBeaconOptions } from '../../../src/runtime/utils/early-beacon'

export const DSN = 'https://cb4e0da9f40eb6fa331bb26592b64bd1@o4510084335534080.ingest.de.sentry.io/4511188847820880'
export const TUNNEL = '/api/sentry-tunnel'
export const PAGE = 'https://ai.pushka.biz/invite/abc123'
/* UA из инцидента ai.pushka.biz 15.10.2026: iOS 16.0.2 — WebKit без import maps. */
export const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

export const OPTIONS: EarlyBeaconOptions = {
  dsn: DSN,
  tunnelEndpoint: TUNNEL,
  release: 'a1b2c3d',
  excludeLocalhostInProd: true,
  version: '0.10.0',
}

export const UNSUPPORTED = { reason: 'unsupported-browser', missing: 'importmap' }

export interface Envelope {
  header: { event_id: string; sent_at: string; dsn: string }
  item: { type: string }
  payload: Record<string, unknown> & { event_id: string; timestamp: number }
}

type BeaconFn = (url: string, body: string) => boolean
type FetchFn = (url: string, init: Record<string, unknown>) => Promise<unknown>
type WindowListener = (event: { type: string; detail?: unknown }) => void

/* Окружение страницы: ровно то, что скрипт берёт у `window`. null — API в браузере отсутствует. */
export interface PageEnv {
  hostname?: string
  href?: string
  sendBeacon?: BeaconFn | null
  fetch?: FetchFn | null
  crypto?: null
}

export interface BootedPage {
  context: object
  navigator: Record<string, unknown>
  sendBeacon: Mock<BeaconFn>
  fetch: Mock<FetchFn>
  listenerCount: number
  loadTimeoutListenerCount: number
  dispatch: (detail: unknown) => void
  dispatchLoadTimeout: (detail: unknown) => void
}

/*
 * Исполняет итоговый текст скрипта в отдельном vm-контексте, где глобал один — фейковый `window`.
 * Любое обращение к голому `navigator`/`location`/`fetch` дало бы ReferenceError, а не молча взяло
 * бы значение хоста; в рантайме браузера скрипт делает то же самое — читает только `window`.
 */
export function boot(options: Partial<EarlyBeaconOptions> = {}, env: PageEnv = {}): BootedPage {
  const script = buildEarlyBeaconScript({ ...OPTIONS, ...options })
  const listeners: WindowListener[] = []
  const loadTimeoutListeners: WindowListener[] = []
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
      if (type === 'app:load-timeout') {
        loadTimeoutListeners.push(listener)
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
    loadTimeoutListenerCount: loadTimeoutListeners.length,
    dispatch(detail) {
      for (const listener of listeners) {
        listener({ type: 'app:chunk-reload-blocked', detail })
      }
    },
    dispatchLoadTimeout(detail) {
      for (const listener of loadTimeoutListeners) {
        listener({ type: 'app:load-timeout', detail })
      }
    },
  }
}

export function parseEnvelope(body: string): Envelope {
  const lines = body.split('\n')
  expect(lines).toHaveLength(3)
  const [header, item, payload] = lines.map((line) => JSON.parse(line) as unknown)
  return { header, item, payload } as Envelope
}

/* Envelope index-го по счёту вызова sendBeacon (по умолчанию первого). */
export function beaconEnvelope(page: BootedPage, index = 0): Envelope {
  return parseEnvelope(String(page.sendBeacon.mock.calls[index]?.[1]))
}
