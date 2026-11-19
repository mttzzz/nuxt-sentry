import MyModule from '../../../src/module'

/* Сборка, как у ai.pushka.biz: SPA (ssr: false), клиентские карты hidden — их загружает плагин Sentry, а серверные
   (`.output/server`, Nitro) чистит модуль. */
export default defineNuxtConfig({
  modules: [MyModule],
  ssr: false,
  sourcemap: { client: 'hidden' },
  vite: { build: { sourcemap: 'hidden' } },
  runtimeConfig: {
    testMode: true,
  },
  compatibilityDate: '2025-10-25',
  sentry: {
    dsn: 'https://test-key@o0.ingest.sentry.io/9999',
    project: 'fixture-sourcemaps',
    cachePrefix: 'fixture-sourcemaps-cache:',
  },
})
