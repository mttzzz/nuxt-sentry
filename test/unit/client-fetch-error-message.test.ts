import { addFetchInstrumentationHandler } from '@sentry/core'
import * as Sentry from '@sentry/vue'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildClientSentryOptions } from '../../src/runtime/utils/client-init-options'

/*
 * Нативный текст сетевой ошибки fetch — контракт приложения и стороннего кода (Safari/iOS «Load failed», Firefox
 * «NetworkError when attempting to fetch resource.», Chrome «Failed to fetch»; AI SDK сравнивает с 'load failed').
 * Sentry 11 по умолчанию дописывает хост прямо в error.message пропатченного fetch — и для относительных URL
 * (`/api/chat`), на 10.x суффикса у них не было. Опыт на настоящем патче fetch: опции собирает модуль, патч ставит
 * настоящий SDK (его обработчики — те, что ставят browserTracing и breadcrumbs).
 *
 * Патч fetch ставится один раз на модуль @sentry/core (флаг instrumented), поэтому всё в одном файле, и этот
 * файл — единственный с настоящим патчем.
 */

const BASE = {
  app: undefined,
  router: undefined,
  dsn: 'https://key@o0.ingest.sentry.io/1',
  release: 'fetch-error-test',
  tunnel: '/api/sentry-tunnel',
  enabled: true,
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  ignoreErrors: [],
  beforeSend: (event: Sentry.ErrorEvent) => event,
  tracePropagationTargets: [/^\/api\//u],
} satisfies Parameters<typeof buildClientSentryOptions>[0]

const NATIVE_FAILURES = ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']

interface SentException {
  type?: string
  value?: string
}
interface SentEvent {
  exception?: { values?: SentException[] }
}

const sentEvents: SentEvent[] = []
let nativeMessage = ''

beforeAll(() => {
  /* «Браузер»: страница на своём origin, fetch отвечает нативным TypeError, как при обрыве сети. */
  vi.stubGlobal('location', { href: 'https://ai.pushka.biz/chats/1' })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError(nativeMessage))),
  )
  Sentry.init({
    ...buildClientSentryOptions(BASE),
    /* Интеграции приложения (Vue, роутер, tracing) тут не нужны: патч fetch ставим тем же вызовом, что и они. */
    integrations: [],
    defaultIntegrations: false,
    transport: () => ({
      send: (envelope) => {
        for (const item of envelope[1]) {
          if (item[0].type === 'event') {
            sentEvents.push(item[1] as SentEvent)
          }
        }
        return Promise.resolve({})
      },
      flush: () => Promise.resolve(true),
    }),
  })
  addFetchInstrumentationHandler(() => {})
})

afterAll(() => {
  vi.unstubAllGlobals()
})

async function failingFetch(url: string, message: string): Promise<unknown> {
  nativeMessage = message
  try {
    await fetch(url)
  } catch (error) {
    return error
  }
  throw new Error('fetch должен был отклониться')
}

describe('клиентский Sentry: текст сетевой ошибки fetch остаётся нативным', () => {
  it.each(NATIVE_FAILURES)('относительный URL, «%s»: error.message приложения без « (host)»', async (message) => {
    const error = await failingFetch('/api/chat', message)

    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe(message)
  })

  it('абсолютный URL чужого хоста: текст приложения тоже нативный', async () => {
    const error = await failingFetch('https://cdn.example.com/x.js', 'Load failed')

    expect((error as TypeError).message).toBe('Load failed')
  })

  it('хост попадает только в событие Sentry — туда, где он помогает разбирать сбои', async () => {
    const error = await failingFetch('/api/chat', 'Load failed')
    expect((error as TypeError).message).toBe('Load failed')

    Sentry.captureException(error)
    await Sentry.flush(1000)

    const values = sentEvents.flatMap((event) => event.exception?.values ?? [])
    expect(values.map((value) => value.value)).toContain('Load failed (ai.pushka.biz)')
  })
})
