export interface ModuleOptions {
    /** Sentry DSN. Required. */
    dsn: string;
    /** Sentry project slug — для sentryVitePlugin (sourcemap upload) и парсинга tunnel ingest URL. Required. */
    project: string;
    /** Redis cache prefix для `Sentry.redisIntegration({ cachePrefixes })`. Required (например 'easy2-pushka-biz-cache:'). */
    cachePrefix: string;
    /** Sentry org slug. Default: 'pushka-biz'. */
    org?: string;
    /** Endpoint для tunnel-проксирования client → ingest. Default: '/api/sentry-tunnel'. */
    tunnelEndpoint?: string;
    /** Default: 0.5 */
    tracesSampleRate?: number;
    /** Default: 0.1 */
    replaysSessionSampleRate?: number;
    /** Default: 1 */
    replaysOnErrorSampleRate?: number;
    /** Default: [/^\/api\//] */
    tracePropagationTargets?: (string | RegExp)[];
    /**
     * Дополнительные паттерны к built-in (view-transition / stale-chunk / manifest-poll).
     * Передаются в `Sentry.init({ ignoreErrors })` как есть.
     */
    additionalIgnorePatterns?: (string | RegExp)[];
    /**
     * Routes, которые tracesSampler выключит из транзакций (sample rate 0).
     * Default: ['/api/sentry-tunnel', '/_nuxt', '/api/ws', '/api/health', '/__nuxt_error']
     */
    ignoredRoutes?: string[];
    /**
     * Если PROD-билд крутится на 127.0.0.1/localhost/0.0.0.0/::1 — не шлём события
     * в Sentry (страховка от прод-Sentry-noise из test-image'ов). Default: true.
     */
    excludeLocalhostInProd?: boolean;
}
export interface ResolvedModuleOptions {
    dsn: string;
    project: string;
    cachePrefix: string;
    org: string;
    tunnelEndpoint: string;
    tracesSampleRate: number;
    replaysSessionSampleRate: number;
    replaysOnErrorSampleRate: number;
    tracePropagationTargets: (string | RegExp)[];
    additionalIgnorePatterns: (string | RegExp)[];
    ignoredRoutes: string[];
    excludeLocalhostInProd: boolean;
}
export interface PublicRuntimeSentryConfig {
    dsn: string;
    project: string;
    cachePrefix: string;
    org: string;
    tunnelEndpoint: string;
    tracesSampleRate: number;
    replaysSessionSampleRate: number;
    replaysOnErrorSampleRate: number;
    ignoredRoutes: string[];
    excludeLocalhostInProd: boolean;
}
