import { afterEach, describe, expect, it, vi } from 'vitest'

const SENTRY_CONFIG = {
  dsn: 'https://cb4e0da9f40eb6fa331bb26592b64bd1@o4510084335534080.ingest.de.sentry.io/4511188847820880',
  project: 'kp-modmb-com',
  tunnelEndpoint: '/api/sentry-tunnel',
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  excludeLocalhostInProd: true,
  release: 'a1b2c3d',
}
const DISABLED = ['/clients/**']
const STACK_LIMIT_BEFORE = Error.stackTraceLimit

type Hook = (payload: unknown) => void

/*
 * Загружает плагин на «документе» с заданным путём. Виртуальные модули Nuxt (`#app`, `#nuxt-sentry/*`) и SDK
 * подменены шпионами: каждый шпион — один побочный эффект, который плагин мог бы произвести. Реестр модулей
 * сбрасывается на каждый прогон, чтобы фабрики моков (и список отключённых путей) были свежими.
 */
async function runPlugin(options: { disabledRoutes: string[]; pathname: string }) {
  vi.resetModules()
  const spies = {
    init: vi.fn(),
    captureException: vi.fn(),
    loadSessionReplay: vi.fn(() => Promise.resolve()),
    createStaleChunkFilter: vi.fn(() => () => null),
    addEventListener: vi.fn(),
  }
  const hooks = new Map<string, Hook>()
  const nuxtApp = {
    vueApp: {},
    hook: vi.fn((name: string, handler: Hook) => {
      hooks.set(name, handler)
    }),
  }
  const location = { hostname: 'kp.modmb.com', pathname: options.pathname }

  vi.stubGlobal('location', location)
  vi.stubGlobal('addEventListener', spies.addEventListener)
  vi.doMock('@sentry/vue', () => ({
    init: spies.init,
    captureEvent: vi.fn(),
    captureException: spies.captureException,
    browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
    vueIntegration: vi.fn(() => ({ name: 'Vue' })),
    captureConsoleIntegration: vi.fn(() => ({ name: 'CaptureConsole' })),
  }))
  vi.doMock('@mttzzz/nuxt-stale-deploy-guard/sentry', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    createSentryStaleChunkFilter: spies.createStaleChunkFilter,
  }))
  vi.doMock('#app', () => ({
    defineNuxtPlugin: (plugin: unknown) => plugin,
    useRouter: () => ({}),
    useRuntimeConfig: () => ({ public: { sentry: SENTRY_CONFIG } }),
  }))
  vi.doMock('#nuxt-sentry/config', () => ({
    additionalIgnorePatterns: [],
    tracePropagationTargets: [],
    disabledRoutes: options.disabledRoutes,
  }))
  vi.doMock('#nuxt-sentry/replay', () => ({ loadSessionReplay: spies.loadSessionReplay }))

  /*
   * Динамический import: плагин обязан вычисляться заново на каждый прогон — после resetModules и doMock со свежими
   * шпионами и списком путей. Статический import вычислил бы его один раз, до моков.
   */
  const { default: plugin } = await import('../../src/runtime/plugin.client')
  await (plugin as unknown as (app: typeof nuxtApp) => Promise<void>)(nuxtApp)

  return { spies, hooks, nuxtApp, location }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  Error.stackTraceLimit = STACK_LIMIT_BEFORE
})

describe('клиентский плагин: документ на отключённом пути', () => {
  it.each(['/clients', '/clients/', '/clients/ckx1a2b3c', '/clients/a/b'])(
    '%s: ни Sentry.init, ни фильтра guard, ни replay, ни слушателя, ни хуков, ни правки Error.stackTraceLimit',
    async (pathname) => {
      const { spies, nuxtApp } = await runPlugin({ disabledRoutes: DISABLED, pathname })

      expect(spies.init).not.toHaveBeenCalled()
      expect(spies.createStaleChunkFilter).not.toHaveBeenCalled()
      expect(spies.loadSessionReplay).not.toHaveBeenCalled()
      expect(spies.addEventListener).not.toHaveBeenCalled()
      expect(nuxtApp.hook).not.toHaveBeenCalled()
      expect(Error.stackTraceLimit).toBe(STACK_LIMIT_BEFORE)
    },
  )

  it('один из нескольких паттернов совпал — документ отключён', async () => {
    const { spies, nuxtApp } = await runPlugin({
      disabledRoutes: ['/share/*', '/clients/**'],
      pathname: '/clients/abc',
    })

    expect(spies.init).not.toHaveBeenCalled()
    expect(nuxtApp.hook).not.toHaveBeenCalled()
  })
})

describe('клиентский плагин: любой другой документ работает как прежде', () => {
  it.each(['/', '/admin/partners', '/clientsx', '/my-clients/abc', '/x/clients/abc'])(
    '%s: Sentry.init один раз, фильтр guard, replay, слушатель chunk-reload-blocked и хуки app:error / vue:error на месте',
    async (pathname) => {
      const { spies, hooks } = await runPlugin({ disabledRoutes: DISABLED, pathname })

      expect(spies.init).toHaveBeenCalledTimes(1)
      expect(spies.init.mock.calls[0]?.[0]).toMatchObject({
        dsn: SENTRY_CONFIG.dsn,
        release: SENTRY_CONFIG.release,
        tunnel: SENTRY_CONFIG.tunnelEndpoint,
      })
      expect(spies.createStaleChunkFilter).toHaveBeenCalledTimes(1)
      expect(spies.loadSessionReplay).toHaveBeenCalledTimes(1)
      expect(spies.addEventListener).toHaveBeenCalledWith('app:chunk-reload-blocked', expect.any(Function))
      expect([...hooks.keys()]).toEqual(['app:error', 'vue:error'])
      expect(Error.stackTraceLimit).toBe(50)
    },
  )

  it('без опции (пустой список) плагин не меняется и на пути /clients/…', async () => {
    const { spies, hooks } = await runPlugin({ disabledRoutes: [], pathname: '/clients/abc' })

    expect(spies.init).toHaveBeenCalledTimes(1)
    expect(spies.loadSessionReplay).toHaveBeenCalledTimes(1)
    expect([...hooks.keys()]).toEqual(['app:error', 'vue:error'])
  })

  it('решение принято при старте документа: переход SPA на отключённый путь уже поднятый Sentry не отключает', async () => {
    const { spies, hooks, location } = await runPlugin({ disabledRoutes: DISABLED, pathname: '/admin/partners' })

    location.pathname = '/clients/abc'
    hooks.get('app:error')?.(new Error('после перехода'))
    hooks.get('vue:error')?.(new Error('после перехода'))

    expect(spies.captureException).toHaveBeenCalledTimes(2)
  })
})
