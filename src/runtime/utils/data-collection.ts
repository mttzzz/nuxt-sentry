import type { DataCollection } from '@sentry/core'

/*
 * Что Sentry собирает в события. До 11 это решал `sendDefaultPii: true`; 11 удалил его и заменил
 * `dataCollection` с более широкими умолчаниями: Bun-SDK начал читать тела входящих запросов (пароли,
 * платежи, вход), очереди и MCP попали в сбор сами. Политика записана здесь ЦЕЛИКОМ, по всем
 * категориям: новое умолчание Sentry в будущем минорном релизе не поменяет, что мы шлём. Одна политика на
 * сервер и клиент — каждый берёт из неё своё, остальное инертно.
 *
 * Значения — то, что на 10.x давал `sendDefaultPii: true` (`defaultPiiToCollectionOptions(true)` в
 * @sentry/core 10.x), кроме трёх осознанных отличий:
 *   - httpBodies: []        на 10.x Bun-SDK тела запросов не читал; 11 читает входящие POST — выключено;
 *   - queues: false         категории на 10.x не было, аргументы задач очередей не собирались;
 *   - mcp: false/false      то же: содержимое MCP-запросов на 10.x не собиралось.
 * Остальное как на 10.x: user/IP, cookie (имена), заголовки, query, кадры стека с 7 строками контекста
 * (11 умолчанием снижает до 5).
 *
 * Секреты 11 маскирует `[Filtered]` в любом режиме `true`: значения cookie с `session`/`token`/`sid`/…
 * в имени (better-auth: `better-auth.session_token`, `__Secure-…`), заголовок `cookie` целиком,
 * `authorization`, `token`/`key`/`secret` в query (@sentry/core, `filtering-snippets`). На 10.x с
 * `sendDefaultPii: true` они уходили сырыми.
 */
export const DATA_COLLECTION: DataCollection = {
  userInfo: true,
  cookies: true,
  httpHeaders: { request: true, response: true },
  httpBodies: [],
  urlQueryParams: true,
  graphQL: { document: true, variables: true },
  genAI: { inputs: true, outputs: true },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: true,
  queues: false,
  stackFrameVariables: true,
  frameContextLines: 7,
}
