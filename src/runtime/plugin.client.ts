import { replayIntegration } from '@sentry/browser'
import * as Sentry from '@sentry/vue'

import { defineNuxtPlugin, useRouter, useRuntimeConfig } from '#app'
// @ts-expect-error virtual module emitted by module.ts via addTemplate + alias
import { additionalIgnorePatterns, tracePropagationTargets } from '#nuxt-sentry/config'

import { buildIgnoreErrors } from './utils/ignore-errors'
import { shouldEnableClientSentry } from './utils/sentry-enabled'

/*
 * Client-side Sentry init: вешает browserTracing/Vue/replay/consoleLogging.
 *
 * `beforeSend` интегрируется со stale-deploy-guard'ом через peer-import
 * `@mttzzz/nuxt-stale-deploy-guard/sentry` — дропает downstream-TypeError'ы
 * после stale-chunk reload. Эти проекты ставятся вместе.
 */
export default defineNuxtPlugin(async (nuxtApp) => {
  // Динамический импорт чтобы peer (stale-deploy-guard) не превращался в hard-dep на этапе compile.
  const { createSentryStaleChunkFilter } = await import('@mttzzz/nuxt-stale-deploy-guard/sentry')

  const config = useRuntimeConfig().public.sentry!
  const router = useRouter()

  Sentry.init({
    app: nuxtApp.vueApp,
    dsn: config.dsn,
    tunnel: config.tunnelEndpoint,
    enabled: shouldEnableClientSentry({
      // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- import.meta.env is virtual module, typed as error but safe at runtime
      isProd: import.meta.env.PROD,
      hostname: globalThis.location.hostname,
      excludeLocalhost: config.excludeLocalhostInProd,
    }),
    tracesSampleRate: config.tracesSampleRate,
    replaysSessionSampleRate: config.replaysSessionSampleRate,
    replaysOnErrorSampleRate: config.replaysOnErrorSampleRate,
    enableLogs: true,
    sendDefaultPii: true,
    attachStacktrace: true,
    normalizeDepth: 8,
    maxValueLength: 2000,
    ignoreErrors: buildIgnoreErrors(additionalIgnorePatterns as (string | RegExp)[]),
    beforeSend: createSentryStaleChunkFilter(),
    tracePropagationTargets: tracePropagationTargets as (string | RegExp)[],
    ignoreSpans: [
      { op: /^browser\.(cache|connect|DNS)$/u },
      { op: 'resource.other', name: /.+\.(woff2|woff|ttf|eot)$/u },
      { op: 'resource.link', name: /.+\.css.*$/u },
      { op: /resource\.(link|script)/u, name: /.+\.js.*$/u },
      { op: /resource\.(other|img)/u, name: /.+\.(png|svg|jpeg|jpg|gif|bmp|tif|tiff|webp|avif|heic|heif|ico).*$/u },
      { op: 'measure' },
    ],
    debug: false,
    integrations: [
      Sentry.browserTracingIntegration({ router }),
      Sentry.vueIntegration({ app: nuxtApp.vueApp, attachErrorHandler: false }),
      // oxlint-disable-next-line typescript/no-unsafe-call -- replayIntegration from @sentry/browser is safe, typed as error due to module resolution
      replayIntegration({
        blockAllMedia: false,
        maskAllInputs: false,
        maskAllText: false,
        networkDetailAllowUrls: [globalThis.location.origin],
      }),
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error', 'info'] }),
    ],
  })

  // Перехват Nuxt/Vue ошибок — captureException sync.
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Nuxt hook API requires callback, not awaitable
  nuxtApp.hook('app:error', (error) => {
    Sentry.captureException(error)
  })
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Nuxt hook API requires callback, not awaitable
  nuxtApp.hook('vue:error', (error) => {
    Sentry.captureException(error)
  })
})
