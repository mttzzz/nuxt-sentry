import { defineEventHandler, readRawBody, setResponseStatus } from 'h3'
import { useRuntimeConfig } from 'nitropack/runtime'

// @ts-expect-error virtual module emitted by module.ts via addTemplate + nitro.alias
import { tunnelIngestUrl } from '#nuxt-sentry/config'

import type { PublicRuntimeSentryConfig } from '../types'

/*
 * Tunnel endpoint: проксирует Sentry envelope от клиента в *.ingest.sentry.io,
 * чтобы обходить ad-blocker'ы. https://docs.sentry.io/.../tunnel
 *
 * Test-mode гейт: если `runtimeConfig.testMode` (NUXT_TEST_MODE=1) или
 * `SENTRY_DISABLED=1` — отвечаем 204 без форварда. Контекст: test-image билдится
 * с NODE_ENV=production (Dockerfile target=production), поэтому client-side
 * Sentry активен и стримит envelope'ы. Без гейта тестовые прогоны попадают
 * в прод-Sentry как реальные инциденты.
 *
 * Ingest URL подставляется build-time из `addTemplate` в src/module.ts.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event) as { testMode?: boolean; public: { sentry: PublicRuntimeSentryConfig } }

  if (config.testMode || process.env.SENTRY_DISABLED === '1') {
    setResponseStatus(event, 204)
    return null
  }

  const rawBody = await readRawBody(event, false)
  if (!rawBody) {
    setResponseStatus(event, 400)
    return { error: 'Empty request body' }
  }

  try {
    // oxlint-disable-next-line typescript/no-unsafe-argument -- tunnelIngestUrl is a build-time string from virtual module, safe as fetch URL
    const response = await fetch(tunnelIngestUrl, {
      body: rawBody,
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
      },
      method: 'POST',
    })

    return { status: response.status }
  } catch {
    /* SDK игнорит статус ответа от tunnel; не роняем приложение. */
    return { status: 200, tunnelError: true }
  }
})
