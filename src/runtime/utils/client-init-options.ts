import * as Sentry from '@sentry/vue'

import { DATA_COLLECTION } from './data-collection'

type ClientInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>
type RouterOption = NonNullable<Parameters<typeof Sentry.browserTracingIntegration>[0]>['router']

/*
 * Опции клиентского `Sentry.init` — отдельной чистой функцией, как серверные (server-init-options.ts):
 * итоговая конфигурация поднимается в тесте настоящим SDK, без плагина Nuxt и виртуальных модулей.
 *
 * Sentry 11 против 10.x на клиенте:
 *   - `sendDefaultPii` и `enableLogs` удалены: политику данных держит DATA_COLLECTION (тела HTTP не собираем,
 *     user/IP — как на 10.x), логи Sentry не включаются, пока в коде нет Sentry.logger/consoleLoggingIntegration;
 *   - сессии браузера (Release Health): умолчание 11 — `lifecycle: 'page'` (сессия на загрузку страницы), на 10.x
 *     было 'route' (новая сессия на каждую навигацию SPA). Возвращено 'route': цифры Release Health не сдвигаются.
 *     Статус сессии при необработанной ошибке в 11 — `unhandled` вместо `crashed`, настроить это нельзя;
 *   - имена resource-спанов стали доменом, а op браузерных таймингов — строчными (`browser.dns`): правила
 *     ignoreSpans ниже написаны под 11 (URL ресурса — в атрибуте `url.full`).
 */

/* Шум трассировки: тайминги соединения, ресурсы-ассеты, performance.measure. Имя resource-спана в 11 — домен,
   поэтому расширение файла ищем в атрибуте url.full (с необязательным ?query/#hash). */
export const CLIENT_IGNORE_SPANS: NonNullable<ClientInitOptions['ignoreSpans']> = [
  { op: /^browser\.(?:cache|connect|dns)$/iu },
  { op: 'resource.other', attributes: { 'url.full': /\.(?:woff2|woff|ttf|eot)(?:[?#].*)?$/u } },
  { op: 'resource.link', attributes: { 'url.full': /\.css(?:[?#].*)?$/u } },
  { op: /resource\.(?:link|script)/u, attributes: { 'url.full': /\.js(?:[?#].*)?$/u } },
  {
    op: /resource\.(?:other|img)/u,
    attributes: { 'url.full': /\.(?:png|svg|jpeg|jpg|gif|bmp|tif|tiff|webp|avif|heic|heif|ico)(?:[?#].*)?$/u },
  },
  { op: 'measure' },
]

export interface ClientInitInput {
  app: ClientInitOptions['app']
  router: RouterOption
  dsn: string
  release: string | undefined
  tunnel: string
  enabled: boolean
  tracesSampleRate: number
  replaysSessionSampleRate: number
  replaysOnErrorSampleRate: number
  ignoreErrors: (string | RegExp)[]
  beforeSend: ClientInitOptions['beforeSend']
  tracePropagationTargets: (string | RegExp)[]
}

export function buildClientSentryOptions(input: ClientInitInput): ClientInitOptions {
  return {
    app: input.app,
    dsn: input.dsn,
    release: input.release,
    tunnel: input.tunnel,
    enabled: input.enabled,
    tracesSampleRate: input.tracesSampleRate,
    replaysSessionSampleRate: input.replaysSessionSampleRate,
    replaysOnErrorSampleRate: input.replaysOnErrorSampleRate,
    dataCollection: DATA_COLLECTION,
    attachStacktrace: true,
    normalizeDepth: 8,
    maxValueLength: 2000,
    ignoreErrors: input.ignoreErrors,
    beforeSend: input.beforeSend,
    tracePropagationTargets: input.tracePropagationTargets,
    ignoreSpans: CLIENT_IGNORE_SPANS,
    debug: false,
    integrations: [
      Sentry.browserTracingIntegration({ router: input.router }),
      Sentry.vueIntegration({ app: input.app, attachErrorHandler: false }),
      Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] }),
      Sentry.browserSessionIntegration({ lifecycle: 'route' }),
    ],
  }
}
