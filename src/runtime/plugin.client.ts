import * as Sentry from '@sentry/vue'

import { defineNuxtPlugin, useRouter, useRuntimeConfig } from '#app'
// @ts-expect-error virtual module emitted by module.ts via addTemplate + alias
import { additionalIgnorePatterns, tracePropagationTargets } from '#nuxt-sentry/config'

import { isNoiseEvent, normalizeConsoleEvent, normalizeMessageEvent } from './utils/before-send'
import { buildIgnoreErrors } from './utils/ignore-errors'
import { shouldEnableClientSentry } from './utils/sentry-enabled'

/*
 * Client-side Sentry init (issues-first observability, см.
 * docs/specs/2026-06-18-issues-first-observability-design.md): browserTracing/Vue
 * + captureConsoleIntegration (любой console.warn/error → Issue с полным контекстом),
 * Sentry Logs выключены (enableLogs:false).
 *
 * Session Replay подключается ПОСЛЕ init динамическим импортом `@sentry/replay` (peer):
 * без ссылки на replayIntegration в статическом коде пакет (sideEffects:false, ~35 КБ gz
 * rrweb-рекордера) выпадает из entry tree-shaking'ом и едет отдельным чанком с origin
 * приложения — не с CDN Sentry: внешние CDN у части пользователей BY/RU недоступны.
 * `client.addIntegration` для пост-init интеграции зовёт afterAllSetup, а replayIntegration
 * читает replaysSessionSampleRate/replaysOnErrorSampleRate из client.getOptions() в момент
 * setup — сэмплирование не меняется. `@sentry/replay` держать в той же версии, что
 * `@sentry/vue`: вторая копия @sentry/core при дрейфе ломает replay молча.
 *
 * `beforeSend` композитный: isNoiseEvent дропает extension/anonymous-recursion шум
 * (под catch-all message-based ignoreErrors его не ловит), normalizeConsoleEvent даёт
 * console-событиям читаемый заголовок и culprit вызывающего, normalizeMessageEvent — прямым
 * captureMessage заголовок из текста сообщения, затем stale-deploy-guard
 * (`@mttzzz/nuxt-stale-deploy-guard/sentry`) дропает downstream-TypeError'ы после
 * stale-chunk reload. Эти проекты ставятся вместе.
 */
async function loadSessionReplay(): Promise<void> {
  const client = Sentry.getClient()
  /* Localhost/dev (shouldEnableClientSentry → false): чанк не грузится вовсе. */
  if (!client || client.getOptions().enabled === false) {
    return
  }
  try {
    const { replayIntegration } = await import('@sentry/replay')
    client.addIntegration(
      replayIntegration({
        blockAllMedia: false,
        maskAllInputs: false,
        maskAllText: false,
        networkDetailAllowUrls: [globalThis.location.origin],
      }),
    )
  } catch (error) {
    /* Сбой чанка (офлайн, окно выкатки) — breadcrumb, не console.warn: captureConsole сделал бы
       Issue из каждого сетевого блипа. */
    Sentry.addBreadcrumb({
      category: 'replay',
      level: 'warning',
      message: `session replay chunk failed: ${String(error)}`,
    })
  }
}

export default defineNuxtPlugin(async (nuxtApp) => {
  // Динамический импорт чтобы peer (stale-deploy-guard) не превращался в hard-dep на этапе compile.
  const { createSentryStaleChunkFilter } = await import('@mttzzz/nuxt-stale-deploy-guard/sentry')

  const config = useRuntimeConfig().public.sentry!
  const router = useRouter()
  const extraIgnore = additionalIgnorePatterns as (string | RegExp)[]
  const staleChunkFilter = createSentryStaleChunkFilter()

  /* V8 (Chrome/Edge) режет стек на 10 кадрах; обвязка captureConsole + withScope + logger —
   * почти столько же, и вызывающий console.warn/error в issue не попадает. Firefox/Safari
   * свойство игнорируют — присваивание безвредно. Подробнее: instrument.server.ts. */
  Error.stackTraceLimit = 50

  Sentry.init({
    app: nuxtApp.vueApp,
    dsn: config.dsn,
    release: config.release,
    tunnel: config.tunnelEndpoint,
    enabled: shouldEnableClientSentry({
      // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- import.meta.env is virtual module, typed as error but safe at runtime
      isProd: import.meta.env.PROD,
      hostname: globalThis.location.hostname,
      excludeLocalhost: config.excludeLocalhostInProd,
    }),
    tracesSampleRate: config.tracesSampleRate,
    replaysSessionSampleRate: config.replaysSessionSampleRate,
    replaysOnErrorSampleRate: config.replaysOnErrorSampleRate ?? 1,
    enableLogs: false,
    sendDefaultPii: true,
    attachStacktrace: true,
    normalizeDepth: 8,
    maxValueLength: 2000,
    ignoreErrors: buildIgnoreErrors(extraIgnore),
    beforeSend: (event) =>
      isNoiseEvent(event) ? null : staleChunkFilter(normalizeMessageEvent(normalizeConsoleEvent(event))),
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
      Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] }),
    ],
  })

  void loadSessionReplay()

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
