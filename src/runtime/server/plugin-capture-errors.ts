import { defineNitroPlugin } from 'nitropack/runtime'

/* Virtual modules — emit'ятся в module.ts. Если соответствующая опция не задана,
   pkg экспортит no-op (filter → () => true, enricher → () => ({})). */
// @ts-expect-error virtual module resolved at build time via nitro alias
import errorReportEnricher from '#nuxt-sentry/error-enricher'
// @ts-expect-error virtual module resolved at build time via nitro alias
import errorReportFilter from '#nuxt-sentry/error-filter'

import { captureNitroError } from '../utils/capture-nitro-error'

/*
 * Форвардит unhandled-ошибки nitro request-pipeline в Sentry. Без этого хука
 * `@sentry/bun` ловит только process-level uncaught exceptions, а 500-ки
 * из server/api/* молча падают в `[request error] [unhandled]`-лог.
 */
export default defineNitroPlugin((nitroApp) => {
  // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Nitro hook API requires callback, not awaitable
  nitroApp.hooks.hook('error', (error, ctx) => {
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- virtual modules typed as error but safe at runtime
    captureNitroError(error, ctx, { filter: errorReportFilter, enricher: errorReportEnricher })
  })
})
