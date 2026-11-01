/*
 * DB-инструментация в этом модуле подключается НЕ через `Sentry.init({ integrations })`.
 * OTEL-based интеграции (`postgresJsIntegration`, `pgIntegration`, `mysql2Integration`)
 * не работают на Bun из-за сломанного `import-in-the-middle` (см. instrument-postgres-js.ts).
 * Поэтому опции `db` нет: вместо неё консьюмер вызывает `instrumentPostgresJs(client)`
 * вручную (auto-import, см. runtime/utils/instrument-postgres-js.ts).
 */

export interface ModuleOptions {
  /** Sentry DSN. Required. */
  dsn: string
  /** Sentry project slug — для sentryVitePlugin (sourcemap upload) и парсинга tunnel ingest URL. Required. */
  project: string
  /** Redis cache prefix для `Sentry.redisIntegration({ cachePrefixes })`. Required (например 'easy2-pushka-biz-cache:'). */
  cachePrefix: string
  /** Sentry org slug. Default: 'pushka-biz'. */
  org?: string
  /** Endpoint для tunnel-проксирования client → ingest. Default: '/api/sentry-tunnel'. */
  tunnelEndpoint?: string
  /** Default: 0.1 */
  tracesSampleRate?: number
  /** Sample rate для custom queue.publish/queue.process транзакций. Default: 0.1. */
  queueTracesSampleRate?: number
  /**
   * Session Replay (peer `@sentry/replay`). `false` — интеграция не подключается и `@sentry/replay`
   * не попадает в клиентскую сборку вовсе (ни чанка, ни prefetch); сэмплинг-опции ниже тогда не
   * действуют. Для тарифов Sentry с малой квотой replay. Default: true.
   */
  replay?: boolean
  /** Default: 0.1 */
  replaysSessionSampleRate?: number
  /** Default: 0.1 */
  replaysOnErrorSampleRate?: number
  /** Default: [/^\/api\//] */
  tracePropagationTargets?: (string | RegExp)[]
  /**
   * Дополнительные паттерны к built-in (view-transition / stale-chunk / manifest-poll).
   * Передаются в `Sentry.init({ ignoreErrors })` как есть.
   */
  additionalIgnorePatterns?: (string | RegExp)[]
  /**
   * Префиксы пути запроса, которые серверный tracesSampler выключит из транзакций (sample rate 0).
   * Сравнение — `startsWith`, не граница сегмента: `/api/ws` гасит и `/api/ws/x`, и `/api/wsx`.
   * Сверка идёт по `url.path` http.server-спана, а без него — по имени спана без ведущего
   * HTTP-метода (`POST /api/x` → `/api/x`).
   * Default: ['/api/sentry-tunnel', '/_nuxt', '/api/ws', '/api/health', '/__nuxt_error']
   */
  ignoredRoutes?: string[]
  /**
   * Если PROD-билд крутится на 127.0.0.1/localhost/0.0.0.0/::1 — не шлём события
   * в Sentry (страховка от прод-Sentry-noise из test-image'ов). Default: true.
   */
  excludeLocalhostInProd?: boolean
  /**
   * Клиентский (браузерный) Sentry. Серверный не затрагивается.
   */
  client?: {
    /**
     * Паттерны путей, на которых клиентский Sentry не работает вовсе: документ, открытый на таком пути, не вызывает
     * `Sentry.init`, не подписывается на события guard'а и не шлёт отчёты раннего inline-beacon'а. Для публичных
     * страниц, окружение которых не починить (встроенные браузеры, кошельки, приватный режим, плохая сеть) и где
     * сигнал из браузера не приводит к правке.
     *
     * Синтаксис (как routeRules Nitro, только целыми сегментами): `/clients` — ровно этот путь; `*` — один непустой
     * сегмент (`/clients/*`); `/**` в конце — префикс и всё под ним (`/clients/**` совпадает с `/clients`,
     * `/clients/abc`, `/clients/a/b`, но не с `/clientsx`). Сверка — с `location.pathname`, с учётом регистра;
     * `*` и `**` внутри сегмента или `**` не в конце бросают ошибку при setup модуля (сборка и старт dev).
     *
     * Решение принимается один раз на ДОКУМЕНТ, по адресу, с которым он загружен: переход внутри SPA его не меняет —
     * документ, открытый на странице персонала, продолжает слать отчёты и после перехода на отключённый путь, а
     * документ, открытый на отключённом пути, не шлёт никогда. Default: [].
     */
    disabledRoutes?: string[]
  }
  /*
   * Path к модулю с default export-функцией:
   *   filter(error) → boolean — return false → событие НЕ шлётся в Sentry.
   *
   * Use case: project-specific skip-патерны ("Cannot find static asset", etc).
   * Если не задано — все non-4xx ошибки идут в Sentry (default-фильтрация 4xx работает всегда).
   *
   * Пример: errorReportFilter: '~/server/utils/error-filter'
   */
  errorReportFilter?: string
  /*
   * Path к модулю с default export-функцией:
   *   enricher(error, event) → { extra?, tags? } — merge'ится поверх default
   *   buildSentryReport (url/method/headers/cause/appData).
   *
   * Use case: project-specific дополнительный контекст для Sentry-issue.
   * Пример: errorReportEnricher: '~/server/utils/error-enricher'
   */
  errorReportEnricher?: string
}

export interface ResolvedModuleOptions {
  dsn: string
  project: string
  cachePrefix: string
  org: string
  tunnelEndpoint: string
  tracesSampleRate: number
  queueTracesSampleRate: number
  replay: boolean
  replaysSessionSampleRate: number
  replaysOnErrorSampleRate: number
  tracePropagationTargets: (string | RegExp)[]
  additionalIgnorePatterns: (string | RegExp)[]
  ignoredRoutes: string[]
  excludeLocalhostInProd: boolean
  client: { disabledRoutes: string[] }
  errorReportFilter?: string
  errorReportEnricher?: string
}

/*
 * Что хранится в runtimeConfig.public.sentry — серверу нужны почти все опции
 * (для instrument.server.ts), клиенту — DSN/tunnelEndpoint/sampleRates/excludeLocalhost.
 * Поскольку клиент всё равно видит DSN (в bundle), ничего нового не утекает.
 *
 * Но `additionalIgnorePatterns` содержит RegExp'ы — они не сериализуются в JSON
 * (улетают в `{}`). Поэтому regex-варианты живут только в runtime-памяти модуля
 * (передаются на client/server плагины через статическую генерацию кода в setup).
 */
export interface PublicRuntimeSentryConfig {
  dsn: string
  project: string
  cachePrefix: string
  org: string
  tunnelEndpoint: string
  tracesSampleRate: number
  queueTracesSampleRate: number
  replaysSessionSampleRate: number
  replaysOnErrorSampleRate: number
  ignoredRoutes: string[]
  excludeLocalhostInProd: boolean
  /*
   * Release name (commit SHA или semver) — теггирует events в Sentry,
   * привязывает sourcemaps и suspect-commits. Читается из `process.env.SENTRY_RELEASE`
   * на build-time. Если не задан — events идут без release, sourcemap upload пропускается.
   */
  release?: string
}
