# @mttzzz/nuxt-sentry

Nuxt 4 module: shared Sentry boilerplate (server init, client init, Prisma span normalization, nitro error capture, tunnel) для проектов pushka.biz/modmb.com.

## Что даёт

- **Server `Sentry.init`** в top-level rollup chunk (`instrument.server.mjs`) — Sentry/OTEL стартуют до application code, Prisma + Redis instrumentation.
- **Prisma span normalization** — санитизирует `db.query.text`, дедупит `IN (?,?,?)` → `IN (?)`, `CONCAT(...)` → `CONCAT(?)`.
- **Nitro `error` hook → Sentry** — форвардит unhandled-ошибки из request-pipeline (`@sentry/bun` сам по себе ловит только process-level).
- **User context** — `Sentry.setUser` из `event.context.user` (better-auth / nuxt-authorization).
- **Client `Sentry.init`** — browser tracing, Vue, replay, console-logging, ignore-errors (view-transition / stale-chunk / manifest-poll noise), `beforeSend` интеграция со `@mttzzz/nuxt-stale-deploy-guard/sentry`.
- **Tunnel** `/api/sentry-tunnel` (с test-mode gate против полива прод-Sentry событиями из test-image'ов).
- **Source-map upload** — `@sentry/vite-plugin` под `SENTRY_AUTH_TOKEN` в production.

## Установка

```sh
bun add github:mttzzz/nuxt-sentry#main
# peer deps уже стоят в проектах: @sentry/bun, @sentry/vue, @sentry/vite-plugin, @prisma/instrumentation
```

## Конфиг

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@mttzzz/nuxt-stale-deploy-guard', '@mttzzz/nuxt-sentry'],
  sentry: {
    dsn: 'https://<key>@<host>/<projectId>', // required
    project: 'easy2-pushka-biz', // required: Sentry project slug
    cachePrefix: 'easy2-pushka-biz-cache:', // required: redis integration prefix
    // org: 'pushka-biz',                     // default
    // tunnelEndpoint: '/api/sentry-tunnel',  // default
    // tracesSampleRate: 0.5,
    // replaysSessionSampleRate: 0.1,
    // replaysOnErrorSampleRate: 1,
    // tracePropagationTargets: [/^\/api\//],
    // additionalIgnorePatterns: [],
    // ignoredRoutes: ['/api/sentry-tunnel', '/_nuxt', '/api/ws', '/api/health', '/__nuxt_error'],
    // excludeLocalhostInProd: true,
  },
})
```

## Env vars

- `NODE_ENV=production` — Sentry активен только здесь.
- `SENTRY_DISABLED=1` — явный off-switch (для test-image'а с `target=production`).
- `NUXT_TEST_MODE=1` (через `runtimeConfig.testMode`) — tunnel отвечает 204, не форвардит.
- `SENTRY_AUTH_TOKEN` — build-time, для sourcemap upload через `@sentry/vite-plugin`.

## Тесты

```sh
bun run test       # vitest run (unit + e2e fixtures)
bun run test:types # vue-tsc --noEmit
bun run lint       # eslint
```
