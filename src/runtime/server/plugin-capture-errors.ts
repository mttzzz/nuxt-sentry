import { defineNitroPlugin } from 'nitropack/runtime'

import { captureNitroError } from '../utils/capture-nitro-error'

/*
 * Форвардит unhandled-ошибки nitro request-pipeline в Sentry. Без этого хука
 * `@sentry/bun` ловит только process-level uncaught exceptions, а 500-ки
 * из server/api/* молча падают в `[request error] [unhandled]`-лог.
 *
 * Логика фильтрации (4xx skip, 5xx + raw → capture) — в `captureNitroError`.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', captureNitroError)
})
