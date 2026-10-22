import * as Sentry from '@sentry/vue'

import { defineNuxtPlugin, useRouter, useRuntimeConfig } from '#app'
// @ts-expect-error virtual module emitted by module.ts via addTemplate + alias
import { additionalIgnorePatterns, tracePropagationTargets } from '#nuxt-sentry/config'
// @ts-expect-error virtual module: реэкспорт utils/session-replay либо no-op при `sentry.replay: false`
import { loadSessionReplay } from '#nuxt-sentry/replay'

import { createClientBeforeSend } from './utils/before-send'
import { listenChunkReloadBlocked } from './utils/chunk-reload-report'
import { buildIgnoreErrors } from './utils/ignore-errors'
import { shouldEnableClientSentry } from './utils/sentry-enabled'

/*
 * Client-side Sentry init (issues-first observability, см.
 * docs/specs/2026-06-18-issues-first-observability-design.md): browserTracing/Vue
 * + captureConsoleIntegration (любой console.warn/error → Issue с полным контекстом),
 * Sentry Logs выключены (enableLogs:false).
 *
 * Session Replay — не в integrations init'а, а после него: `loadSessionReplay` из
 * `#nuxt-sentry/replay` (utils/session-replay.ts: динамический импорт peer `@sentry/replay`,
 * отдельный чанк; при `sentry.replay: false` модуль подставляет no-op, и rrweb в сборке нет).
 * `@sentry/replay` держать в той же версии, что `@sentry/vue`: вторая копия @sentry/core при
 * дрейфе ломает replay молча.
 *
 * `beforeSend` композитный: isNoiseEvent дропает extension/anonymous-recursion шум и инжект
 * браузера — стек на URL документа или на скрипте без URL, событие без кадров — по точной
 * сигнатуре инжекта (под catch-all message-based ignoreErrors его не ловит), normalizeConsoleEvent даёт
 * console-событиям читаемый заголовок и culprit вызывающего, normalizeMessageEvent — прямым
 * captureMessage заголовок из текста сообщения, затем stale-deploy-guard
 * (`@mttzzz/nuxt-stale-deploy-guard/sentry`) дропает downstream-TypeError'ы после
 * stale-chunk reload. Эти проекты ставятся вместе. Композицию делает createClientBeforeSend;
 * отчёты guard'а о проглоченных сбоях чанка (тег chunk.reason) обходят этот последний фильтр.
 *
 * После init плагин слушает `app:chunk-reload-blocked` — событие guard'а «сбой чанка проглочен,
 * перезагрузки не будет» — и шлёт Sentry-событие, по одному на reason (chunk-reload-report.ts).
 * Исход `unsupported-browser` (браузер без import maps) сюда не доходит: приложение там не
 * стартует — его шлёт ранний inline-beacon из <head> (early-beacon.ts). Исход `retry-failed`
 * (страница не загрузилась и после перезагрузки, guard ≥ 0.6.0) reporter игнорирует: Nuxt стартует
 * первую навигацию раньше этого плагина, SDK к событию может быть не поднят, поэтому его тоже шлёт
 * только ранний beacon — при поднятом SDK второй отправитель дал бы дубль. Событие watchdog'а
 * (`app:load-timeout`, guard ≥ 0.7.0) плагин не слушает вовсе — его шлёт только ранний beacon.
 */

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
    beforeSend: createClientBeforeSend(staleChunkFilter),
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

  void (loadSessionReplay as () => Promise<void>)()

  /*
   * Watchdog'а ('app:load-timeout') SDK-путь не слушает: приложение к этому моменту не смонтировалось, значит
   * клиентский SDK не поднят — отчёт уходит только ранним beacon'ом (early-beacon.ts). Слушать его здесь
   * означало бы второй отчёт при поднятом SDK.
   */
  listenChunkReloadBlocked((event) => {
    Sentry.captureEvent(event)
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
