import { shouldIgnoreSpan } from '@sentry/core'
import * as Sentry from '@sentry/vue'
import { describe, expect, it, vi } from 'vitest'

import { buildClientSentryOptions, CLIENT_IGNORE_SPANS } from '../../src/runtime/utils/client-init-options'
import { DATA_COLLECTION } from '../../src/runtime/utils/data-collection'

/* Фабрика интеграции у SDK не показывает свои опции: lifecycle сессии проверяем по аргументам вызова. */
vi.mock('@sentry/vue', async (importOriginal) => {
  const actual = await importOriginal<typeof Sentry>()
  return { ...actual, browserSessionIntegration: vi.fn(actual.browserSessionIntegration) }
})

const BASE = {
  app: undefined,
  router: undefined,
  dsn: 'https://key@o0.ingest.sentry.io/1',
  release: 'client-test',
  tunnel: '/api/sentry-tunnel',
  enabled: false,
  tracesSampleRate: 0,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  ignoreErrors: ['noise'],
  beforeSend: (event: Sentry.ErrorEvent) => event,
  tracePropagationTargets: [/^\/api\//u],
} satisfies Parameters<typeof buildClientSentryOptions>[0]

describe('клиентский Sentry: итоговая конфигурация', () => {
  it('удалённые в 11 опции не передаются: sendDefaultPii, enableLogs', () => {
    const options = buildClientSentryOptions(BASE)
    expect(Object.keys(options)).not.toContain('sendDefaultPii')
    expect(Object.keys(options)).not.toContain('enableLogs')
  })

  it('опции: стек у captureMessage, глубина, длина значений, туннель, пропагация только на /api/', () => {
    expect(buildClientSentryOptions(BASE)).toMatchObject({
      attachStacktrace: true,
      normalizeDepth: 8,
      maxValueLength: 2000,
      tunnel: '/api/sentry-tunnel',
      tracePropagationTargets: [/^\/api\//u],
      release: 'client-test',
      debug: false,
    })
  })

  it('политика сбора данных на клиенте та же: как на 10.x с sendDefaultPii, без тел HTTP', () => {
    const { dataCollection } = buildClientSentryOptions(BASE)
    const client = new Sentry.BrowserClient({
      dsn: BASE.dsn,
      enabled: false,
      dataCollection,
      integrations: [],
      stackParser: Sentry.defaultStackParser,
      transport: Sentry.makeFetchTransport,
    })
    expect(client.getDataCollectionOptions()).toEqual({
      userInfo: true,
      cookies: true,
      httpHeaders: { request: true, response: true },
      httpBodies: [],
      urlQueryParams: true,
      graphQL: { document: true, variables: true },
      genAI: { inputs: true, outputs: true },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: true,
      queues: false,
      stackFrameVariables: true,
      frameContextLines: 7,
    })
    expect(buildClientSentryOptions(BASE).dataCollection).toBe(DATA_COLLECTION)
  })

  it('интеграции: трассировка, Vue, console → issue, сессии браузера по-прежнему на каждую навигацию', () => {
    const { integrations } = buildClientSentryOptions(BASE)
    expect(Array.isArray(integrations)).toBe(true)
    expect((integrations as { name: string }[]).map((integration) => integration.name)).toEqual([
      'BrowserTracing',
      'Vue',
      'CaptureConsole',
      'BrowserSession',
    ])
    expect(Sentry.browserSessionIntegration).toHaveBeenCalledWith({ lifecycle: 'route' })
  })
})

describe('клиентский ignoreSpans (под имена и атрибуты спанов Sentry 11)', () => {
  function ignored(span: { description: string; op: string; attributes?: Record<string, unknown> }): boolean {
    return shouldIgnoreSpan(span, CLIENT_IGNORE_SPANS)
  }

  it.each(['browser.cache', 'browser.connect', 'browser.dns', 'browser.DNS'])('тайминг %s — шум', (op) => {
    expect(ignored({ description: 'ai.pushka.biz', op })).toBe(true)
  })

  it.each([
    ['resource.script', 'https://ai.pushka.biz/_nuxt/entry.CrUuv-rO.js'],
    ['resource.script', 'https://ai.pushka.biz/_nuxt/entry.js?v=1'],
    ['resource.link', 'https://ai.pushka.biz/_nuxt/main.abc.css'],
    ['resource.other', 'https://ai.pushka.biz/_fonts/inter.woff2'],
    ['resource.other', 'https://ai.pushka.biz/_fonts/inter.ttf#frag'],
    ['resource.img', 'https://ai.pushka.biz/logo.png'],
    ['resource.img', 'https://cdn.example.com/photo.jpg'],
    ['resource.other', 'https://ai.pushka.biz/favicon.ico?x=1'],
  ])('ресурс %s %s — шум (имя спана в 11 — домен, расширение в url.full)', (op, url) => {
    expect(ignored({ description: new URL(url).hostname, op, attributes: { 'url.full': url } })).toBe(true)
  })

  it('performance.measure — шум', () => {
    expect(ignored({ description: 'nuxt:app', op: 'measure' })).toBe(true)
  })

  it.each([
    ['resource.script', 'https://ai.pushka.biz/api/data.json'],
    ['resource.img', 'https://ai.pushka.biz/api/avatar'],
    ['http.client', 'https://ai.pushka.biz/_nuxt/entry.js'],
    ['pageload', 'https://ai.pushka.biz/'],
    ['navigation', 'https://ai.pushka.biz/app.js'],
  ])('%s %s — не шум', (op, url) => {
    expect(ignored({ description: new URL(url).hostname, op, attributes: { 'url.full': url } })).toBe(false)
  })
})
