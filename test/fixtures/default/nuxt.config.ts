import StaleDeployGuard from '@mttzzz/nuxt-stale-deploy-guard'

import MyModule from '../../../src/module'

export default defineNuxtConfig({
  modules: [StaleDeployGuard, MyModule],
  ssr: false,
  runtimeConfig: {
    testMode: true,
  },
  compatibilityDate: '2025-10-25',
  sentry: {
    dsn: 'https://test-key@o0.ingest.sentry.io/9999',
    project: 'fixture-default',
    cachePrefix: 'fixture-default-cache:',
  },
})
