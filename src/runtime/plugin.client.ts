import { replayIntegration } from '@sentry/browser'
import * as Sentry from '@sentry/vue'

import { defineNuxtPlugin, useRouter, useRuntimeConfig } from '#app'
// @ts-expect-error virtual module emitted by module.ts via addTemplate + alias
import { additionalIgnorePatterns, tracePropagationTargets } from '#nuxt-sentry/config'

import { buildIgnoreErrors } from './utils/ignore-errors'
import { shouldEnableClientSentry } from './utils/sentry-enabled'

import type { PublicRuntimeSentryConfig } from './types'

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

  const config = useRuntimeConfig().public.sentry as PublicRuntimeSentryConfig
  const router = useRouter()

  Sentry.init({
    app: nuxtApp.vueApp,
    dsn: config.dsn,
    tunnel: config.tunnelEndpoint,
    enabled: shouldEnableClientSentry({
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
      { op: /^browser\.(cache|connect|DNS)$/ },
      { op: 'resource.other', name: /.+\.(woff2|woff|ttf|eot)$/ },
      { op: 'resource.link', name: /.+\.css.*$/ },
      { op: /resource\.(link|script)/, name: /.+\.js.*$/ },
      { op: /resource\.(other|img)/, name: /.+\.(png|svg|jpeg|jpg|gif|bmp|tif|tiff|webp|avif|heic|heif|ico).*$/ },
      { op: 'measure' },
    ],
    debug: false,
    integrations: [
      Sentry.browserTracingIntegration({ router }),
      Sentry.vueIntegration({ app: nuxtApp.vueApp, attachErrorHandler: false }),
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
  nuxtApp.hook('app:error', (error) => {
    Sentry.captureException(error)
  })
  nuxtApp.hook('vue:error', (error) => {
    Sentry.captureException(error)
  })
})
