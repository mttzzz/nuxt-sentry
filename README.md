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

## Server-side utilities (auto-imported)

После регистрации модуля в server-runtime'е consumer'а доступны следующие auto-imports — без явного `import`:

### `createLogger(tag) → Logger`

```ts
const log = createLogger('amo-sync')
log.debug('low-level diag', { count }) // off в production
log.info('synced ok', { count }) // + Sentry breadcrumb (info)
log.warn('rate limit hit', { retry: 3 }) // + Sentry breadcrumb (warning)
log.error('upstream failed', err) // → Sentry captureException (Error в args) или captureMessage
```

Семантика по уровням и breadcrumb-механика — в `src/runtime/utils/logger.ts`.

### `defineSentryTask({ meta, run })`

```ts
export default defineSentryTask({
  meta: { name: 'amo-sync', description: 'Sync Amo entities', cron: '*/5 * * * *' },
  async run({ logger }) {
    logger.info('sync start')
    return { synced: 5 }
  },
})
```

Получает `logger` с тегом `task:<name>`, оборачивает в `Sentry.startNewTrace + startSpan(op:'task') + withMonitor` (если есть `cron`). Catch внутри — error не пробрасывается, возвращается `{ result: 'error', message }`.

### `withCronMonitor(slug, schedule, fn, opts?)`

Низкоуровневый wrapper для случаев вне Nitro task'а. `defineSentryTask` использует его внутри.

### `instrumentPostgresJs(sql)`

(существует с v0.2) — оборачивает postgres-js клиент для Sentry DB spans на Bun.

## Sub-path exports (явный import)

```ts
// Bull queue tracing (opt-in: peer-dep bull)
import { instrumentQueueProducer, withSentryConsumer } from '@mttzzz/nuxt-sentry/queue'

// Client logger (app/, не auto-import)
import { createLogger } from '@mttzzz/nuxt-sentry/logger/client'
```

## Error pipeline customization

В `nuxt.config.ts`:

```ts
sentry: {
  dsn: '...',
  project: '...',
  cachePrefix: '...',

  // Path к модулю с default export — функция (error) → boolean
  // false → событие НЕ шлётся в Sentry (после default 4xx-skip)
  errorReportFilter: '~~/server/utils/error-filter',

  // Path к модулю с default export — функция (error, event) → { extra?, tags? }
  // Merge'ится поверх default extras (url/method/headers/cause/appData)
  errorReportEnricher: '~~/server/utils/error-enricher',
}
```

**Важно про путь:** в Nuxt 4 `~/` указывает на `app/`, `~~/` — на корень проекта. Поскольку filter/enricher живут в `server/`, используйте `~~/server/...`. Pkg валидирует существование файла на этапе module setup и кидает понятную ошибку, если path не резолвится.

Default report: `url`, `method`, `headers` (JSON-serialized), `error.cause` (с AWS-style $metadata), `error.data` (h3 createError data → `appData`). Tag: `source: nitro-error-hook`.

### Заголовки console-issue

`captureConsoleIntegration` шлёт `console.warn/error` синтетическим exception'ом без `type` и с `mechanism.synthetic`, и Sentry титулует такой issue именем функции верхнего `in_app`-фрейма — то есть sink'ом логгера (`output`) у всех событий одинаково. `beforeSend` (client + server) прогоняет их через `normalizeConsoleEvent`: ставит `type = console.<level>`, снимает `synthetic` (иначе сервер не кладёт `type` в metadata и заголовок остаётся именем функции) — заголовок становится `console.warn: [tag] сообщение` — и гасит `in_app` у фреймов sink'а, чтобы culprit указывал на вызывающий код.

Группировка — по стеку вызывающего, поэтому стек синтетического исключения обязан до него доставать: `Error.stackTraceLimit` поднят до 50 (`instrument.server.ts`, `plugin.client.ts`). С дефолтными 10 кадрами обвязка `captureConsole` + `withSourceScope` + sink съедала стек целиком, все `logger.error` приложения приходили с одинаковым «system-only» стеком и слипались в один issue (ai.pushka.biz, AI-PUSHKA-BIZ-5J: три разных сообщения в одном issue). Текст сообщения в группировке не участвует — интерполированные идентификаторы в нём безопасны.

Первый деплой после обновления разово перегруппирует существующие console-issue: старые перестанут получать события, заведутся новые с читаемыми заголовками.

## Тесты

```sh
bun run test       # vitest run (unit + e2e fixtures)
bun run test:types # vue-tsc --noEmit
bun run lint       # oxlint
bun run fmt        # oxfmt
```
