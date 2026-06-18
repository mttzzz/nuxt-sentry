# Issues-first Observability — эталонная Sentry-настройка для всех Nuxt-проектов

**Дата:** 2026-06-18
**Pkg:** `@mttzzz/nuxt-sentry` (текущая 0.6.0 → target 0.7.0)
**Драйвер:** kp.modmb.com (эталон-валидация); раскатка на ai/easy2/vincera — отдельные фазы
**Статус:** дизайн утверждён по двум ключевым решениям, ждёт review спеки → writing-plans

---

## 1. Контекст и цель

Сейчас философия модуля: `consoleLoggingIntegration` гонит `console.warn/error/info` в **Sentry Logs**, а `createLogger().error()` дополнительно делает explicit `captureException` → Issue. Итог: ошибки идут И в Logs, И в Issues (частичный дубль), warn'ы оседают только breadcrumb'ами и **в Issues не попадают**, а Logs зашумлены console-выводом. Дебажить трудно: «страшная» ошибка тонет в Logs, а не заводит actionable Issue.

**Цель (эталон для всех 5 Nuxt-проектов):**
- **Sentry Logs пустые** (фича Logs выключена).
- **Любой `console.warn` / `console.error`** (наш `createLogger`, сырой console, сторонние либы, Vue) → **Issue с максимально полным контекстом** (stacktrace+source-maps, session replay, breadcrumbs, user, `source`-тег).
- **Issues чистые** — известный сторонний/браузерный шум отсекается (иначе catch-all зальёт Issues мусором).
- Легко дебажить: открыл Issue → видишь стек по исходникам + replay-видео + хлебные крошки.

## 2. Ключевые решения (утверждены пользователем)

- **Механизм — A: `captureConsoleIntegration` catch-all.** `captureConsoleIntegration({ levels: ['warn', 'error'] })` на client И server. Любой warn/error-console → Issue. Один канал → ноль дублей. `createLogger` упрощается: пишет в console + обогащает Sentry-scope (`source`-тег, extra) → Issue выходит с полным контекстом. Logger **перестаёт** делать explicit `captureException`/`captureMessage` (иначе дубль с captureConsole).
- **Logs — выключены.** `enableLogs: false` на client и server; `consoleLoggingIntegration` и `beforeSendLog` удаляются.

Отвергнуто: B (explicit-only через logger) — теряет сырой console.error / сторонние / Vue-warnings, не выполняет «любые». error-only — противоречит «любые варнинги».

## 3. Архитектура изменений (в модуле `@mttzzz/nuxt-sentry`)

### 3.1. `src/runtime/plugin.client.ts` (@sentry/vue)
- **Убрать** `Sentry.consoleLoggingIntegration({ levels: [...] })` и опцию `beforeSendLog`.
- **Добавить** `Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] })`.
- `enableLogs: true` → **`false`**.
- **Сохранить** (это и есть «полный контекст»): `browserTracingIntegration`, `vueIntegration({ attachErrorHandler: false })`, `replayIntegration(...)`, `attachStacktrace: true`, `normalizeDepth`, `maxValueLength`, `sendDefaultPii`, ручные `app:error`/`vue:error` → `captureException`.
- **`beforeSend`** — скомпоновать: текущий `createSentryStaleChunkFilter()` + новый **noise-filter по стеку** (см. §3.4). Сейчас beforeSend = только stale-chunk; делаем композицию `composeBeforeSend(staleChunkFilter, noiseStackFilter)`.
- `ignoreErrors: buildIgnoreErrors(extraIgnore)` — остаётся (message-based фильтр); теперь применяется к Issues (как и раньше через ignoreErrors, но теперь это основной канал).

### 3.2. `src/runtime/instrument.server.ts` (@sentry/bun)
- **Добавить** `Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] })` в `integrations` (сейчас там только bunServer + redis; серверный console.warn/error сейчас не уходит в Sentry вообще).
- `enableLogs: true` → **`false`**.
- Серверный `beforeSend` отсутствует — добавить тот же noise-stack-filter + (для сервера stale-chunk не нужен) — минимально noise-filter если применимо; на сервере браузерных расширений нет, но сторонний шум возможен. Композиция по аналогии.
- `ignoreErrors` на сервере сейчас не задан — **добавить** `buildIgnoreErrors()` (серверный набор; view-transition/replay не релевантны, но network/манифест — да; вынести релевантное подмножество или переиспользовать общий список — решить в plan).

### 3.3. `src/runtime/utils/logger.ts` + `client-logger.ts` (reshape под catch-all)
Новая семантика уровней (единая server+client):
- `debug` → console-only, off в prod (как сейчас).
- `info` → console + `Sentry.addBreadcrumb({ level: 'info' })` (контекст, НЕ Issue).
- `warn` → **console.warn внутри `Sentry.withScope`** с `scope.setTag('source', tag)` + `scope.setExtras({...})`. captureConsole ловит этот console.warn в форкнутом scope → **Issue (level=warning)** с `source`-тегом и extra, без утечки тегов в глобальный scope.
- `error` → то же через `console.error` → **Issue (level=error)**. Если в args есть `Error` — captureConsole возьмёт его stacktrace; иначе синтезирует из call-site.
- **Удаляется** `sink.captureException`/`sink.captureMessage` — capture теперь неявный через captureConsole. `LoggerSink` reshape'ится (поле `withScope`/`addBreadcrumb` + `output`); тесты обновляются.
- Когда Sentry disabled (dev/localhost) — `withScope`/captureConsole no-op, logger просто пишет в console (dev-DX сохранён).

**Инвариант анти-дубля:** ровно ОДИН путь capture — captureConsole. Logger НЕ зовёт `captureException` напрямую. (Проверить в реализации: `withScope` + `captureConsoleIntegration` — что тег реально попадает на event; captureConsole капчит синхронно в текущем scope. Если на практике scope не подхватывается — fallback: logger делает explicit capture, а captureConsole не вешаем на logger-префиксованные сообщения. Дефолт — withScope-путь.)

### 3.4. NEW: `src/runtime/utils/noise-stack-filter.ts` (beforeSend по стеку)
Под catch-all message-based `ignoreErrors` НЕ ловит шум, у которого нормальное сообщение, но мусорный стек (пример: браузерное расширение рекурсивно патчит `Object.getOwnPropertyDescriptor` → `RangeError: Maximum call stack size exceeded`, стек из одних анонимных `_getOwnPropertyDescriptor`; message generic → ignoreErrors мимо).

`noiseStackFilter(event): event | null` — дропает event, если **все/подавляющее большинство** фреймов стека:
- из `chrome-extension://` / `moz-extension://` / `safari-extension://` / `<anonymous>`;
- рекурсия одного фрейма (один `function@file:line:col` повторяется N+ раз) — сигнатура extension-патча / бесконечной рекурсии в инжектнутом коде;
- известные расширения (`_getOwnPropertyDescriptor`-self-recursion).
Возвращает `null` (drop) для таких; иначе event как есть. Покрыто unit-тестами (реальный extension-payload из KP-MODMB-COM-M → drop; настоящий app-error → pass).

Композиция: `composeBeforeSend(...filters)` — прогоняет event через цепочку, первый вернувший `null` дропает.

### 3.5. Context maximization (для «легко дебажить»)
- **`replaysOnErrorSampleRate: 1.0`** — каждый Issue получает replay-видео. Сейчас берётся из `config.replaysOnErrorSampleRate` (runtime/env). Эталон-рекомендация: дефолт 1.0 (per-project env override остаётся). Записать в README как эталон-дефолт.
- Source maps — `@sentry/vite-plugin` уже грузит (release + authToken); проверить что в kp настроено (иначе стек минифицирован).
- Breadcrumbs (console/navigation/fetch/clicks) — Sentry default, остаются. console-breadcrumb сосуществует с captureConsole: один console.error → и breadcrumb (контекст), и Issue.

## 4. kp.modmb.com — валидация (Phase 2)
1. `bun update @mttzzz/nuxt-sentry` (на 0.7.0).
2. **Убрать** из `nuxt.config.ts` паттерн `/_getOwnPropertyDescriptor/` — он был log-only хак (beforeSendLog); теперь extension-шум ловит noise-stack-filter (§3.4) на уровне Issue. (View-transition/manifest/network паттерны остаются — они message-based и валидны для Issues.)
3. `bun fmt + lint:fix + typecheck` + полный suite.
4. **Verify на проде/preview:** (а) Sentry Logs пустые (новых записей нет); (б) `createLogger('x').warn('test')` и `.error('test', new Error())` → Issue с `source: x`, stacktrace, replay; (в) extension-RangeError (issue KP-MODMB-COM-M) больше НЕ заводит Issue (noise-filter дропает); (г) реальная ошибка на `/clients/[id]` → Issue с replay.

## 5. Rollout (Phase 3, отдельные сессии)
Per «single-bump rule» из shared-logger-спеки, но эталон валидируем на kp ПЕРВЫМ. После зелёного kp:
- easy2 / ai / vincera: `bun update` → проверить, что их `console.warn`-сценарии не зашумляют Issues (у ai/easy2 больше raw-логирования — возможно потребуется доп. ignoreErrors/noise-паттерны per-project). Каждый проект — отдельная verify-сессия.
- Изменение в модуле — новый DEFAULT (не opt-in флаг): эталон должен быть единым. Проекты получают новую философию на bump; рассинхрон допустим временно (kp на 0.7.0, остальные на 0.6.0 пока не валидированы).

## 6. Тесты (в модуле)
- `noise-stack-filter.test.ts` — extension-payload (KP-MODMB-COM-M) → null; app-error со здоровым стеком → pass; mixed (часть extension) → решение по порогу.
- `logger.test.ts` — обновить под новый sink: warn/error → withScope+console (мок captureConsole-канала через sink), source-тег и extra прокинуты, info → breadcrumb, debug → off в prod, анти-дубль (нет прямого captureException).
- `client-logger.test.ts` — аналогично.
- Playground smoke: route с `createLogger('demo').warn(...)` + console.error → проверить через мок-transport, что прилетел Issue (не log), с тегом.
- Существующие тесты (ignore-errors, tunnel, instrument-postgres) — сохранить.

## 7. Риски и митигации
| Риск | Митигация |
|---|---|
| Скачок шума: catch-all warn+error зальёт Issues | kp почти не юзает raw console (всё через logger); noise-stack-filter + message-ignoreErrors; на проде Vue-dev-warnings не эмитятся (prod-build), Sentry на localhost выключен. ai/easy2 — отдельная verify (могут потребовать доп. паттерны). |
| `withScope` + captureConsole не прокидывает тег | Проверить в реализации; fallback — explicit capture в logger + captureConsole не на logger-сообщениях. |
| Дубли (logger explicit + captureConsole) | Один канал: logger НЕ делает explicit capture. Инвариант в тестах. |
| Изменение бьёт по всем 5 проектам на bump | Phased: kp первым, остальные не бампают до своей verify-сессии. Dist коммитится, проекты пинят версию. |
| Потеря Logs как канала | Осознанное решение пользователя; всё actionable → Issues, контекст → breadcrumbs/replay. |

## 8. Out of scope
- Не трогаем `better-auth-logger.ts` в проектах (адаптер библиотеки).
- Не вводим runtime LOG_LEVEL env (YAGNI, как в shared-logger-спеке).
- Не мигрируем ai/easy2/vincera в этой спеке — только модуль + валидация kp. Их раскатка — Phase 3.
- Не меняем server DB/queue/cron-обвязку.
