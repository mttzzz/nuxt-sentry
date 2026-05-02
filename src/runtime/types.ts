/**
 * Какую DB-инструментацию подключать в `Sentry.init`.
 *   - `'prisma'`     → `@prisma/instrumentation` + `Sentry.prismaIntegration` (требует peer `@prisma/instrumentation`)
 *   - `'postgres-js'`→ `Sentry.postgresJsIntegration` (драйвер `postgres`, aka postgres-js — для drizzle/postgres-js)
 *   - `'pg'`         → `Sentry.postgresIntegration` (драйвер `pg`)
 *   - `'mysql2'`     → `Sentry.mysql2Integration` (драйвер `mysql2`)
 *   - `false`        → не подключать DB-инструментацию вообще
 *
 * Default: `'prisma'` (back-compat с проектами, которые ставят пакет до v0.2.0).
 */
export type SentryDbInstrumentation = 'prisma' | 'postgres-js' | 'pg' | 'mysql2' | false

export interface ModuleOptions {
  /** Sentry DSN. Required. */
  dsn: string
  /** Sentry project slug — для sentryVitePlugin (sourcemap upload) и парсинга tunnel ingest URL. Required. */
  project: string
  /** Redis cache prefix для `Sentry.redisIntegration({ cachePrefixes })`. Required (например 'easy2-pushka-biz-cache:'). */
  cachePrefix: string
  /** Sentry org slug. Default: 'pushka-biz'. */
  org?: string
  /** DB-инструментация для server `Sentry.init`. Default: `'prisma'`. См. {@link SentryDbInstrumentation}. */
  db?: SentryDbInstrumentation
  /** Endpoint для tunnel-проксирования client → ingest. Default: '/api/sentry-tunnel'. */
  tunnelEndpoint?: string
  /** Default: 0.5 */
  tracesSampleRate?: number
  /** Sample rate для custom queue.publish/queue.process транзакций. Default: 1 (back-compat). */
  queueTracesSampleRate?: number
  /** Default: 0.1 */
  replaysSessionSampleRate?: number
  /** Default: 1 */
  replaysOnErrorSampleRate?: number
  /** Default: [/^\/api\//] */
  tracePropagationTargets?: (string | RegExp)[]
  /**
   * Дополнительные паттерны к built-in (view-transition / stale-chunk / manifest-poll).
   * Передаются в `Sentry.init({ ignoreErrors })` как есть.
   */
  additionalIgnorePatterns?: (string | RegExp)[]
  /**
   * Routes, которые tracesSampler выключит из транзакций (sample rate 0).
   * Default: ['/api/sentry-tunnel', '/_nuxt', '/api/ws', '/api/health', '/__nuxt_error']
   */
  ignoredRoutes?: string[]
  /**
   * Если PROD-билд крутится на 127.0.0.1/localhost/0.0.0.0/::1 — не шлём события
   * в Sentry (страховка от прод-Sentry-noise из test-image'ов). Default: true.
   */
  excludeLocalhostInProd?: boolean
}

export interface ResolvedModuleOptions {
  dsn: string
  project: string
  cachePrefix: string
  org: string
  db: SentryDbInstrumentation
  tunnelEndpoint: string
  tracesSampleRate: number
  queueTracesSampleRate: number
  replaysSessionSampleRate: number
  replaysOnErrorSampleRate: number
  tracePropagationTargets: (string | RegExp)[]
  additionalIgnorePatterns: (string | RegExp)[]
  ignoredRoutes: string[]
  excludeLocalhostInProd: boolean
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
}
