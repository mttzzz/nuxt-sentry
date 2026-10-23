# @mttzzz/nuxt-sentry

Nuxt 4 module: shared Sentry boilerplate (server init, client init, Prisma span normalization, nitro error capture, tunnel) для проектов pushka.biz/modmb.com.

## Что даёт

- **Server `Sentry.init`** в top-level rollup chunk (`instrument.server.mjs`) — Sentry/OTEL стартуют до application code, Prisma + Redis instrumentation.
- **Server `tracesSampler`** — решает, какие корневые спаны становятся транзакциями: корневые db/cache-спаны (Redis-команды вне запроса) и `ignoredRoutes` отрезаются, очереди идут по `queueTracesSampleRate`, остальное — по `tracesSampleRate`. Подробности — раздел «Серверный tracesSampler».
- **Prisma span normalization** — санитизирует `db.query.text`, дедупит `IN (?,?,?)` → `IN (?)`, `CONCAT(...)` → `CONCAT(?)`.
- **Nitro `error` hook → Sentry** — форвардит unhandled-ошибки из request-pipeline (`@sentry/bun` сам по себе ловит только process-level).
- **User context** — `Sentry.setUser` из `event.context.user` (better-auth / nuxt-authorization).
- **Client `Sentry.init`** — browser tracing, Vue, console-logging, ignore-errors (view-transition / stale-chunk / manifest-poll noise), `beforeSend` интеграция со `@mttzzz/nuxt-stale-deploy-guard/sentry`. `beforeSend` дропает события, у которых весь стек не наш: анонимные кадры, `*-extension://`, движковые `[native code]`, кадры на URL самого документа и кадры с источником `undefined` — так WebKit (Chrome iOS) атрибутирует ошибки инжектированных браузером скриптов перевода/автозаполнения; код приложения живёт только в бандлах. Исключение без кадров дропается только по точной сигнатуре такого инжекта (`Error: La`). Session Replay подключается после init динамическим импортом `@sentry/replay` — отдельный чанк с origin приложения, entry легче на ~35 КБ gz; на localhost/dev (Sentry выключен) чанк не грузится. `replay: false` убирает `@sentry/replay` из сборки целиком (тарифы с малой квотой replay).
- **Tunnel** `/api/sentry-tunnel` (с test-mode gate против полива прод-Sentry событиями из test-image'ов).
- **Отчёт о проглоченных сбоях чанков** — событие `app:chunk-reload-blocked` от `@mttzzz/nuxt-stale-deploy-guard` («сбой чанка проглочен, перезагрузки не будет») становится Sentry-событием: по одной issue на причину, мимо `ignoreErrors` и `staleChunkFilter`. Раздел «Сбои загрузки чанков».
- **Ранний inline-beacon** — для исходов, при которых клиентского SDK нет или он ещё не поднят: браузер без import maps (iOS < 16.4, приложение не стартует), `retry-failed` — страница не загрузилась и после автоматической перезагрузки (guard ≥ 0.6.0) и `app:load-timeout` — watchdog'а «приложение не загрузилось за N с» (guard ≥ 0.7.0; стадия и диагностика причины — guard ≥ 0.8.0). ES5-скрипт в `<head>` сам шлёт событие через tunnel. Только в production-сборке.
- **Source-map upload** — `@sentry/vite-plugin` под `SENTRY_AUTH_TOKEN` в production.

## Установка

```sh
bun add github:mttzzz/nuxt-sentry#main
# peer deps уже стоят в проектах: @sentry/bun, @sentry/vue, @sentry/replay, @sentry/vite-plugin, @prisma/instrumentation
# @sentry/replay держать в той же версии, что @sentry/vue (вторая копия @sentry/core при дрейфе ломает replay молча)
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
    // replay: true,                          // false → @sentry/replay не попадает в сборку вовсе
    // replaysSessionSampleRate: 0.1,
    // replaysOnErrorSampleRate: 1,
    // tracePropagationTargets: [/^\/api\//],
    // additionalIgnorePatterns: [],
    // ignoredRoutes: ['/api/sentry-tunnel', '/_nuxt', '/api/ws', '/api/health', '/__nuxt_error'], // префиксы пути — без транзакций
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

## Серверный tracesSampler

Sentry зовёт `tracesSampler` только для корневых спанов (без локального и удалённого родителя), дочерние наследуют решение корня. Правила (`runtime/utils/traces-sampler.ts`), первое сработавшее побеждает:

1. Корень с `sentry.op` = `db` / `db.*` / `cache` / `cache.*` → `0`. Подписчик Sentry на TracingChannel `ioredis:command` (ioredis ≥ 5.11, в том числе вложенный в bull) не требует родительского спана: каждая Redis-команда вне запроса — опрос bull (`BRPOPLPUSH`/`EVALSHA` раз в 5 с на очередь), stream-консьюмеры (`XREADGROUP`) — становилась транзакцией из одного спана (ai.pushka.biz: ≈720k из ~800k транзакций в сутки). DB/cache-спаны внутри настоящего запроса или джобы не затронуты — они дочерние.
2. Имя `queue.publish/…` / `queue.process/…` → `queueTracesSampleRate`.
3. Путь из `ignoredRoutes` → `0`. Это **префиксы** пути (`startsWith`, не граница сегмента: `/api/ws` гасит и `/api/ws/x`, и `/api/wsx`; точное совпадение списком не выразить). Сверка — по `url.path` http.server-спана, без него — по имени спана без ведущего HTTP-метода (`POST /api/x` → `/api/x`). До 0.9.1 сверялось имя целиком (`GET /api/ws`), и ни один маршрут из `ignoredRoutes` не совпадал никогда (ai.pushka.biz: `GET /api/ws` — 4 390, `POST /api/sentry-tunnel` — 1 460 транзакций в сутки).
4. Остальное → `tracesSampleRate`.

После обновления до 0.9.1 число серверных транзакций заметно падает — это отрезан шум, а не потеря запросов.

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

### Заголовки console-issue и прямых captureMessage

`captureConsoleIntegration` шлёт `console.warn/error` синтетическим exception'ом без `type` и с `mechanism.synthetic`, и Sentry титулует такой issue именем функции верхнего `in_app`-фрейма — то есть sink'ом логгера (`output`) у всех событий одинаково. `beforeSend` (client + server) прогоняет их через `normalizeConsoleEvent`: ставит `type = console.<level>`, снимает `synthetic` (иначе сервер не кладёт `type` в metadata и заголовок остаётся именем функции) — заголовок становится `console.warn: [tag] сообщение` — и гасит `in_app` у фреймов sink'а, чтобы culprit указывал на вызывающий код.

Группировка — по стеку вызывающего, поэтому стек синтетического исключения обязан до него доставать: `Error.stackTraceLimit` поднят до 50 (`instrument.server.ts`, `plugin.client.ts`). С дефолтными 10 кадрами обвязка `captureConsole` + `withSourceScope` + sink съедала стек целиком, все `logger.error` приложения приходили с одинаковым «system-only» стеком и слипались в один issue (ai.pushka.biz, AI-PUSHKA-BIZ-5J: три разных сообщения в одном issue). Текст сообщения в группировке не участвует — интерполированные идентификаторы в нём безопасны.

Первый деплой после обновления разово перегруппирует существующие console-issue: старые перестанут получать события, заведутся новые с читаемыми заголовками.

Прямой `Sentry.captureMessage(text, { level, fingerprint, … })` под тем же `attachStacktrace: true` уезжает той же формой (typeless synthetic exception, mechanism `generic`) — и без нормализации сервер титулует issue именем функции crash-location (ai.pushka.biz AI-PUSHKA-BIZ-5Q: «announceFeedback» вместо «Обратная связь от …»). `normalizeMessageEvent` переносит стек в `threads` (как `attach_stacktrace` в sentry-python): событие становится message-событием, заголовок — первая строка сообщения, стек виден в issue, группировка — по стеку вызывающего либо по переданному `fingerprint`. Console-события и настоящие исключения не трогаются.

## Сбои загрузки чанков: `app:chunk-reload-blocked`

`@mttzzz/nuxt-stale-deploy-guard` на сбой загрузки чанка всегда гасит ошибку (`preventDefault()` у `vite:preloadError` — импорт резолвится в `undefined`), сверяет build-id HEAD-пробами и перезагружает страницу, только если билд устарел. Всё остальное раньше было немым: vue-router бросал «Couldn't resolve component», `ignoreErrors` (`STALE_CHUNK_PATTERNS`) дропал все захваты, пробы видели тот же build-id — пользователь на ошибке, в Sentry ноль. Так прошёл инцидент ai.pushka.biz 15.10.2026: iPhone на iOS 16.0.2 (WebKit без import maps) открывал инвайт и получал `500 Module specifier '#entry' …`.

Теперь каждый исход «guard проглотил сбой и перезагрузки НЕ будет» guard сообщает событием `window` `app:chunk-reload-blocked` (`CustomEvent`, `detail.reason` — причина), а nuxt-sentry отправляет его в Sentry. Нужна версия guard, которая это событие диспатчит; с более старой слушатели просто ничего не получат.

Отдельный исход — `retry-failed` (guard ≥ 0.6.0): страница не загрузилась ДО `app:mounted`. Guard один раз сам перезагружает страницу (маркер `sdg-retry` в URL); если сбой повторился, он показывает экран «Страница не загрузилась» и диспатчит `retry-failed` — один раз за загрузку страницы. `detail.kind` — что не загрузилось: `chunk` (чанк страницы) или `entry` (`<script type="module">` точки входа); `detail.error` и `detail.url` (адрес не загрузившегося скрипта) есть, если guard их знает. Первый сбой, закончившийся успешной перезагрузкой, не диспатчится — такие перезагрузки считаются по логам шлюза по `sdg-retry=`.

**Версии идут парой.** `retry-failed` диспатчит guard ≥ 0.6.0, а отправляет nuxt-sentry ≥ 0.11.0: nuxt-sentry < 0.11.0 молча отбрасывает неизвестный `reason`, так что guard 0.6.0 с ним отчёта не даёт; nuxt-sentry 0.11.0 с guard < 0.6.0 просто не получает этого события. Обновляйте оба пакета вместе.

### Что появится в Sentry

| `reason`              | Заголовок issue                              | `level`   | Исход                                                                                       |
| --------------------- | -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `unsupported-browser` | Браузер без import maps                      | `warning` | В браузере нет import maps: приложение не стартует, guard показывает экран-заглушку         |
| `not-stale`           | Чанк не загрузился, билд актуален            | `error`   | Ни одна проба не увидела чужой build-id: деплоя нет, а чанк не грузится (сеть, блокировщик) |
| `circuit-breaker`     | Чанк не загрузился, перезагрузки исчерпаны   | `error`   | Guard хотел перезагрузить страницу, circuit breaker запретил                                |
| `cooldown`            | Чанк не загрузился сразу после перезагрузки  | `error`   | Проверка пропущена: идёт cooldown после reload                                              |
| `no-build-id`         | Чанк не загрузился, build-id неизвестен      | `error`   | У клиента нет build-id, сверять нечего                                                      |
| `retry-failed`        | Страница не загрузилась и после перезагрузки | `error`   | Сбой до `app:mounted` повторился после перезагрузки guard'а (`kind`: `chunk` / `entry`)     |

- **Одна issue на причину:** `fingerprint: ['chunk-reload-blocked', reason]`; у `retry-failed` — `['chunk-reload-blocked', 'retry-failed', kind]` (сбой entry и сбой чанка — разные issue). Плагин шлёт одно событие на `reason` за загрузку страницы (дедуп в памяти) — повторы одной причины квоту не тратят.
- **Теги:** `chunk.reason`; `chunk.kind` — только у `retry-failed` (`chunk` / `entry`); `chunk.error` — первые 200 символов сообщения исходной ошибки в одну строку (если она есть); `chunk.missing` — только у `unsupported-browser` (`importmap`).
- **`contexts.chunk`:** `reason`; исходная ошибка `{ name, message, stack }` (текст и стек — до 2000 символов); `probes`, `buildId`, `attempts`, `windowMs` — те, что есть у причины; у `retry-failed` ещё `kind` и `url` (адрес не загрузившегося скрипта, до 2000 символов).
- **Кто отправляет:** `not-stale`, `circuit-breaker`, `cooldown`, `no-build-id` — плагин (SDK); `unsupported-browser` — ранний beacon (приложение там не стартует); `retry-failed` — **только** ранний beacon. Reporter плагина `retry-failed` игнорирует: Nuxt стартует первую навигацию раньше клиентских плагинов, поэтому SDK к событию может быть не поднят, а при поднятом SDK второй отправитель дал бы дубль.
- **Исходная ошибка не уходит как `exception`/`cause`:** её текст совпадает с `STALE_CHUNK_PATTERNS`, и `ignoreErrors` срезал бы событие тем же способом, что обнулил репорты в инциденте. Поэтому она лежит только в контексте и теге, а заголовки issue собственные — ни один не матчится `buildIgnoreErrors()` (проверяет тест).
- **Мимо `staleChunkFilter`:** фильтр guard'а дропает событие, если в последние 5 с в breadcrumbs был console.error про stale-chunk, а отчёт приходит как раз следом за таким console.error. Композитный `beforeSend` (`createClientBeforeSend`) пропускает событие с тегом `chunk.reason` мимо этого фильтра; остальную нормализацию оно проходит как обычно.
- **Не шлются** (контракт guard): пропуск проверки из-за уже идущей верификации (исход отправит она) и вердикты опроса `verifyConvergedAndReload`.

### Ранний beacon: браузеры без import maps, `retry-failed` и watchdog

Три исхода случаются, когда клиентского SDK нет или он ещё не поднят, и плагин отправить событие не может:

- **Браузер без import maps** (WebKit < 16.4): приложение не стартует — Nuxt 4.1+ кладёт entry в `<script type="importmap">` под ключом `#entry`, импорт падает, `Sentry.init` не выполняется.
- **`retry-failed`**: страница не загрузилась до `app:mounted` и после перезагрузки. Чанк страницы импортируется при первой навигации, которую Nuxt стартует раньше клиентских плагинов (в том числе этого модуля), а entry мог не скачаться вовсе.
- **`app:load-timeout`** (watchdog, guard ≥ 0.7.0): приложение не смонтировалось за отведённое время (по умолчанию 45 с; с guard ≥ 0.8.0 считается только видимое время) — приложение не загрузилось. SDK не поднят по определению: не загрузилось то, что его поднимает.

Поэтому в production-сборке модуль добавляет в `<head>` небольшой inline-скрипт (≈8,4 КБ, ≈2,8 КБ gz), которому SDK не нужен:

- слушает то же `app:chunk-reload-blocked` и реагирует **только** на `reason: 'unsupported-browser'` (его диспатчит inline-скрипт guard ≥ 0.5.1 в конце `<body>` сразу после `window.stop()`, так что запрос-отчёт остановкой не обрывается) и на `reason: 'retry-failed'` с `kind` `chunk` или `entry` (guard ≥ 0.6.0, когда страница не загрузилась и после перезагрузки); detail с другим `kind` и остальные причины игнорируются — их шлёт плагин;
- отдельно слушает `app:load-timeout` (watchdog'а, guard ≥ 0.7.0) — и только его;
- собирает envelope сам и отправляет `navigator.sendBeacon(tunnelEndpoint, body)`; если `sendBeacon` нет, он вернул `false` или бросил — `fetch(tunnelEndpoint, { method: 'POST', body, keepalive: true })`. Заголовок envelope: `event_id`, `sent_at` и `dsn` — DSN обязателен: tunnel пересылает тело в `…/api/<projectId>/envelope/` без ключа;
- событие то же, что у SDK-пути (заголовок, `level`, `fingerprint`, теги и `contexts.chunk` строит общая `toChunkReloadBlockedEvent`, при сборке её результат вшивается в скрипт — по шаблону на `unsupported-browser` и на каждый `kind` у `retry-failed`), плюс то, что известно только в браузере: `request.url`, `request.headers['User-Agent']` (по нему Sentry определяет браузер и ОС), `release`, `environment: production`, `sdk: { name: 'nuxt-sentry.early-beacon', version }`, а из `detail` — исходная ошибка `detail.error` (Error-подобный объект, строка или любое значение: тег `chunk.error` и `contexts.chunk.error` по тем же правилам, что у SDK-пути, тест сверяет оба пути на одних данных) и адрес скрипта `contexts.chunk.url` (`detail.url`). IP клиента дописывает tunnel;
- DSN, `tunnelEndpoint`, `release`, `excludeLocalhostInProd` и версия пакета вшиваются при сборке; скрипт кладётся в `app.head.script` с ключом `nuxt-sentry-early-beacon` и `tagPosition: 'head'` — раньше bodyClose-скрипта guard, который диспатчит событие, и раньше entry `<script type="module">` (e2e-тест фикстуры проверяет порядок в собранном HTML);
- одно событие на `reason` за загрузку страницы (не больше одного `unsupported-browser`, не больше одного `retry-failed` и не больше одного `app:load-timeout`);
- **выключен:** в dev (скрипта нет в HTML — `nuxt.options.dev`); на `localhost`/`127.0.0.1`/`::1`/`0.0.0.0` при `excludeLocalhostInProd: true` (тот же список хостов, что у клиентского SDK); в test-image'ах (`runtimeConfig.testMode`, `SENTRY_DISABLED=1`) tunnel отвечает `204` без форварда — как и для SDK.

Экраны («Версия iOS устарела» / «Браузер устарел» и «Страница не загрузилась») рисует guard, а не этот модуль. Текст скрипта — ES5, тест проверяет его парсером `acorn` с `ecmaVersion: 5` и исполняет в окружении без SDK.

### Watchdog «приложение не загрузилось за N с»: `app:load-timeout`

Guard ≥ 0.7.0 ставит в свой inline-скрипт в `<head>` таймер: если приложение не смонтировалось за `timeoutMs` (по умолчанию 45 с) — приложение не загрузилось. Раньше это была тишина: страница висит (или висит пустой экран), а Sentry молчит — клиентский SDK не поднялся, ведь не загрузилось то, что его поднимает.

Guard ≥ 0.8.0 и nuxt-sentry ≥ 0.13.0 меняют watchdog в трёх местах: (1) таймер считает только **видимое** время — скрытая, замороженная или уснувшая вкладка в порог не входит, а вкладка, которая так и не стала видимой, отчёта не даёт; (2) отчёт несёт минимальный набор для поиска причины; (3) Sentry делит отчёты на issue по стадии, а у сетевой стадии — ещё и по хосту. Поводом стал разбор KP-MODMB-COM-1J: 4 из 10 событий оказались скрытыми или замороженными вкладками (восстановление сессии Chrome из девяти фоновых вкладок, вкладка Android, замороженная на две минуты), одно — медленной мобильной сетью, а пять — настоящей мёртвой загрузкой iPhone Safari, до которой дошли только HTML и `legacy-polyfills.js`. Ровно такую сигнатуру даёт зависший `<link rel="stylesheet">` в `<head>` (CSS шрифтов или `entry.css` с CDN): `readyState` остаётся `loading`, `#__nuxt` не появляется, ошибок нет — без причины в отчёте такие события не отличить.

Guard диспатчит window `CustomEvent` `app:load-timeout` с detail:

| Поле                            | Значение                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`                        | `'load-timeout'`                                                                                                                                                     |
| `timeoutMs`                     | порог **видимого** ожидания (опция guard'а `loadTimeoutMs`); у guard 0.7.0 — время по часам                                                                          |
| `visibleMs`                     | видимое время, набежавшее к моменту отчёта (≥ `timeoutMs`)                                                                                                           |
| `hiddenMs`                      | `max(0, elapsedMs - visibleMs)`: время, пока вкладка была скрыта, заморожена или спала                                                                               |
| `elapsedMs`                     | сколько прошло по часам с момента исполнения inline-скрипта guard'а                                                                                                  |
| `url`                           | адрес страницы (`location.href`)                                                                                                                                     |
| `kind?`                         | `chunk` \| `entry` — сбой до монтирования, который скрипт видел до отчёта                                                                                            |
| `stage`                         | `network` — не пришли критичные ресурсы (`pending` не пуст) или сам документ ещё стримится (`readyState` = `loading`); `boot` — всё пришло, приложение не стартовало |
| `host?`                         | только у `network`: хост первого зависшего ресурса; ждать нечего, а документ стримится — хост самой страницы                                                         |
| `readyState`                    | `document.readyState` на момент отчёта                                                                                                                               |
| `online`                        | `navigator.onLine` (`true`, если свойства нет)                                                                                                                       |
| `pending`                       | до 5 зависших критичных ресурсов в порядке документа, каждый — `host + pathname` (без query и hash), до 120 символов                                                 |
| `pendingCount`, `criticalCount` | сколько критичных ресурсов зависло и сколько их всего в документе                                                                                                    |
| `vueMounted`                    | в документе есть элемент с `[data-v-app]`: Vue смонтирован, а плагин guard'а о монтировании не сообщил                                                               |
| `errors`                        | до 3 первых ошибок до монтирования (runtime-ошибки и `unhandledrejection`): `{ message, source? }`, `source` — `host + pathname:line:col`                            |

Критичные ресурсы — `<link rel="stylesheet">` (кроме `alternate`, `disabled` и не подходящих по `media`), `<link rel="modulepreload">` и `<script src>` (кроме классических `async`); `prefetch`, `preload`, `icon` и `preconnect` не критичны. Зависшим считается ресурс, которого нет в Resource Timing; без него `pending` пуст.

Событие в Sentry:

| Поле            | Значение                                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`       | `network`: «Приложение не загрузилось за 30 с: не пришли ресурсы (fonts.googleapis.com)»; `boot`: «Приложение не загрузилось за 30 с: сбой при старте»; N = `round(timeoutMs / 1000)`                                                                      |
| `level`         | `error` у всех стадий                                                                                                                                                                                                                                      |
| `fingerprint`   | `network`: `['app-load-timeout', 'network', host]`; `boot`: `['app-load-timeout', 'boot']`                                                                                                                                                                 |
| `tags`          | `load.timeoutMs`, `load.visibleMs`, `load.hiddenMs`, `load.elapsedMs`, `load.pendingCount` (числа строками); `load.stage`; `load.host` (только `network`); `load.readyState`; `load.online`, `load.vueMounted` (`true` / `false`); `load.kind` (если есть) |
| `contexts.load` | все валидные поля detail: числа, `url`, `kind`, `stage`, `host`, `readyState`, `online`, `vueMounted`, `criticalCount`, `pending` (массив строк), `errors` (массив `{ message, source? }`)                                                                 |

- **Одна issue на стадию, у `network` — ещё и на хост.** «Не пришёл CSS шрифтов» (чужой CDN) и «не пришёл entry с нашего CDN» — разные причины с разными владельцами, а «приложение не стартовало при целых ресурсах» — третья. Остальное (`visibleMs`, `hiddenMs`, `elapsedMs`, `url`, `pending`, `readyState`, `online`, `vueMounted`, `errors`) на fingerprint не влияет: оно лежит в тегах и в контексте. Заголовок зависит от `timeoutMs` (число секунд), стадии и хоста.
- **Хост.** Валидный `host` — непустая строка; в заголовок, fingerprint и тег `load.host` он идёт одной строкой без краёв и не длиннее 200 символов (лимит значения тега), в контексте — до 2000. Если у `network` валидного хоста нет, в заголовке и fingerprint стоит `unknown`, а тега и ключа контекста `host` нет. У `boot` и без стадии поле `host` игнорируется.
- **Общий заголовок.** Если `timeoutMs` — не положительное конечное число, число в заголовке пропадает, уточнение остаётся: «Приложение не загрузилось: сбой при старте».
- **Detail guard 0.7.0 (без `stage`) даёт прежний отчёт:** заголовок «Приложение не загрузилось за 45 с», fingerprint `['app-load-timeout']` (одна issue), теги `load.timeoutMs`, `load.elapsedMs`, `load.kind` (если есть), контекст `timeoutMs`, `elapsedMs`, `kind?`, `url?`. Так же читается detail с неизвестным или не строковым `stage`: уточнения и хоста нет, остальные валидные поля попадают в отчёт.
- **Поля проверяются независимо.** Битое или отсутствующее поле (не конечное число, не строка, не boolean, не массив) просто не попадает в отчёт и не ломает остальные. В `pending` пропускаются не строки, в `errors` — записи без строкового `message`, а нестроковый или пустой `source` отбрасывается один. Пустые `pending` и `errors` остаются пустыми массивами.
- **Лимиты.** Значения тегов `load.host` и `load.readyState` — до 200 символов; текст в контексте (`url`, `host`, `readyState`, элементы `pending`, `message` и `source` ошибок) — до 2000.
- **Кто отправляет:** **только** ранний beacon. SDK-путь (плагин) это событие не слушает вовсе: приложение к этому моменту не смонтировалось, значит клиентский SDK не поднят, а при поднятом SDK второй отправитель дал бы дубль. Скрипт собирает событие сам, теми же правилами, что `toLoadTimeoutEvent`: тест сверяет оба пути на одних и тех же detail (`network`, `boot`, detail guard 0.7.0, битые поля).
- **Один отчёт на документ.** Guard диспатчит событие один раз в момент, когда порог видимого ожидания достигнут, — без отложенных дополнений и отправки на `pagehide`; beacon тоже шлёт не больше одного `app:load-timeout` за загрузку страницы.
- **Версии идут парой.** Watchdog диспатчит guard ≥ 0.7.0, а отправляет nuxt-sentry ≥ 0.12.0: nuxt-sentry < 0.12.0 не знает про это window-событие и молча его игнорирует, так что guard 0.7.0 с ним отчёта не даёт; nuxt-sentry 0.12.0 с guard < 0.7.0 просто не получает этого события. Стадии и диагностика — guard ≥ 0.8.0 и nuxt-sentry ≥ 0.13.0: nuxt-sentry 0.12.0 читает у нового detail только `timeoutMs`, `elapsedMs`, `kind` и `url` — получится одна issue `['app-load-timeout']` без причины, а nuxt-sentry 0.13.0 с guard 0.7.0 даёт прежний отчёт (см. выше). Обновляйте оба пакета вместе.

## Тесты

```sh
bun run test       # vitest run (unit + e2e fixtures)
bun run test:types # vue-tsc --noEmit
bun run lint       # oxlint
bun run fmt        # oxfmt
```
