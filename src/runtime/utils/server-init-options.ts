import * as Sentry from '@sentry/bun'
import type { BunOptions } from '@sentry/bun'
import type { Event, Integration } from '@sentry/core'

import { isNoiseEvent, normalizeConsoleEvent, normalizeMessageEvent } from './before-send'
import { DATA_COLLECTION } from './data-collection'
import { otelEventTraceIntegration } from './otel-event-trace'
import { createTracesSampler } from './traces-sampler'

/*
 * Опции серверного `Sentry.init` — отдельной чистой функцией, чтобы итоговую конфигурацию можно было
 * поднять в тесте настоящим SDK (instrument.server.ts — top-level чанк с побочным эффектом, импортировать
 * его нельзя). Build-time плейсхолдеры подставляет renderChunk только в коде самого instrument-чанка:
 * сюда значения приходят аргументами.
 *
 * Мониторинг на Sentry 11 остаётся таким, каким был на 10.x. Что 11 включает сам и что здесь возвращено:
 *   - тела запросов                      → DATA_COLLECTION.httpBodies: [] и maxRequestBodySize: 'none' у обеих
 *                                          Bun-интеграций (11 читает входящие POST: пароли, платежи, вход);
 *   - request-сессии (release health)    → sessions: false у bunServerIntegration/bunHttpServerIntegration;
 *                                          остаётся процессная сессия `processSessionIntegration`, как на 10.x;
 *   - sentry-trace/baggage в исходящие   → tracePropagationTargets: [] (ни fetch, ни node:http(s) — адреса
 *                                          пользователей, шлюз моделей, платёжки, S3 заголовков Sentry не получают)
 *                                          и без fetchIntegration целиком (breadcrumbs/спаны исходящего fetch на
 *                                          Bun на 10.x не было);
 *   - dedupeIntegration                  → убрана: она режет подряд идущие одинаковые события ГЛОБАЛЬНО, и
 *                                          у сервера счётчики событий и «затронутых пользователей» занизились
 *                                          бы (на 10.x сервер её не имел, браузер имел);
 *   - systemErrorIntegration (`NodeSystemError`) → снята: на Bun ≥ 1.4.3 она активна (на 10.x в Bun-SDK её не было),
 *                                          вырезает `'path'` и `'dest'` из exception.value (у ENOENT/EACCES пропадает
 *                                          путь — меняются заголовки и, без in-app кадров, группировка issue) и
 *                                          добавляет contexts.node_system_error;
 *   - runtime-инжект диагностических каналов → enableRuntimeChannelInjection: false: на Bun 1.4.4 он
 *                                          неактивен (нет Module.registerHooks), но Bun выдаёт версию Node 26 —
 *                                          с появлением registerHooks SDK начал бы патчить модули сам.
 *   - trace_id событий в OTel-спане      → интеграция OtelEventTrace (utils/otel-event-trace.ts): событие внутри
 *                                          активного OTel-спана стороннего провайдера (chassis ядра) несёт его
 *                                          trace_id и span_id, как на 10.x (@sentry/opentelemetry); на 11 без неё —
 *                                          trace браузера (sentry-trace) или http.server-спана Sentry;
 * Прочие новые умолчания 11 оставлены: conversationIdIntegration и error-интеграции фреймворков инертны без своих
 * фреймворков.
 */

/* Имена интеграций, которых на 10.x в Bun-SDK не было и которые 11 ставит по умолчанию (их побочные эффекты — выше). */
const DROPPED_DEFAULT_INTEGRATIONS: Record<string, true> = { Fetch: true, Dedupe: true, NodeSystemError: true }

export interface ServerInitInput {
  dsn: string
  release: string | undefined
  enabled: boolean
  cachePrefix: string
  tracesSampleRate: number
  queueTracesSampleRate: number
  ignoredRoutes: readonly string[]
}

/*
 * Дефолты SDK минус возвращённое, плюс наши. Явные экземпляры идут последними: фильтр дубликатов по
 * имени оставляет последний, поэтому BunServer и Redis заменяют одноимённые дефолты.
 */
export function buildServerIntegrations(defaults: Integration[], cachePrefix: string): Integration[] {
  return [
    ...defaults.filter(({ name }) => !Object.hasOwn(DROPPED_DEFAULT_INTEGRATIONS, name)),
    /* Явный экземпляр с настройками, а не дефолт: Bun.serve ядра (публичный и внутренний порт). */
    Sentry.bunServerIntegration({ maxRequestBodySize: 'none', sessions: false }),
    /* Серверы на node:http внутри процесса (Bun не публикует http.server.request.start). */
    Sentry.bunHttpServerIntegration({ maxRequestBodySize: 'none', sessions: false }),
    Sentry.redisIntegration({ cachePrefixes: [cachePrefix] }),
    /* Issues-first: серверный console.warn/error → Issue (через createLogger или сырой). */
    Sentry.captureConsoleIntegration({ levels: ['warn', 'error'] }),
    /* Событие внутри активного OTel-спана — с его trace_id/span_id (на 11 их перекрывал спан самого Sentry). */
    otelEventTraceIntegration(),
  ]
}

/* Дропаем anonymous-recursion/extension шум (под catch-all message-ignoreErrors его не ловит), затем
   нормализуем console-события (читаемый заголовок + culprit на реальном вызывающем) и прямые
   captureMessage (заголовок — текст сообщения, а не функция кадра). */
function serverBeforeSend<T extends Event>(event: T): T | null {
  return isNoiseEvent(event) ? null : normalizeMessageEvent(normalizeConsoleEvent(event))
}

/* `enableRuntimeChannelInjection` читает NodeClient: его создаёт `Sentry.init` Bun-SDK (через init из `@sentry/node`);
   BunClient наследует ServerRuntimeClient и в этом пути не участвует. В типе BunOptions опции нет. */
export type ServerSentryOptions = BunOptions & { enableRuntimeChannelInjection: boolean }

export function buildServerSentryOptions(input: ServerInitInput): ServerSentryOptions {
  return {
    dsn: input.dsn,
    release: input.release,
    enabled: input.enabled,

    integrations: (defaults) => buildServerIntegrations(defaults, input.cachePrefix),

    /* Какие корневые спаны становятся транзакциями — utils/traces-sampler.ts (чистая фабрика, покрыта юнитами). */
    tracesSampler: createTracesSampler({
      tracesSampleRate: input.tracesSampleRate,
      queueTracesSampleRate: input.queueTracesSampleRate,
      ignoredRoutes: input.ignoredRoutes,
    }),
    tracePropagationTargets: [],

    dataCollection: DATA_COLLECTION,
    attachStacktrace: true,
    normalizeDepth: 8,
    enableRuntimeChannelInjection: false,

    beforeSend: serverBeforeSend,

    debug: false,
  }
}
