export default defineNuxtConfig({
  modules: ['@mttzzz/nuxt-stale-deploy-guard', '@mttzzz/nuxt-sentry'],
  ssr: false,
  devtools: { enabled: true },
  runtimeConfig: {
    testMode: process.env.NUXT_TEST_MODE === '1',
  },
  compatibilityDate: 'latest',
  sentry: {
    dsn: 'https://example@o0.ingest.sentry.io/1234567',
    project: 'playground',
    cachePrefix: 'playground-cache:',
  },
})
