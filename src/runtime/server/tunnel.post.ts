import { defineEventHandler, getRequestIP, readRawBody, setResponseStatus } from 'h3'
import { useRuntimeConfig } from 'nitropack/runtime'

// @ts-expect-error virtual module emitted by module.ts via addTemplate + nitro.alias
import { tunnelIngestUrl } from '#nuxt-sentry/config'

import type { PublicRuntimeSentryConfig } from '../types'
import { enrichEnvelope } from '../utils/enrich-envelope'

interface MaybeUser {
  id?: string
  email?: string
  name?: string | null
}

/*
 * Tunnel endpoint: проксирует Sentry envelope от клиента в *.ingest.sentry.io,
 * чтобы обходить ad-blocker'ы. https://docs.sentry.io/.../tunnel
 *
 * Перед форвардом обогащаем event/transaction items реальным client-IP +
 * (опц.) auth user payload из better-auth сессии. Без инжекта Sentry видит
 * коннект из пода k8s (egress-IP ноды) и теряет настоящий IP юзера; user
 * остаётся «anonymous» даже для залогиненных. См. masterm SentryTunnel
 * (commits 55beeef + cde00aa) — тот же паттерн для Laravel.
 *
 * Client IP резолвится через h3 `getRequestIP({xForwardedFor:true})` —
 * берёт первый IP из X-Forwarded-For. В k8s + Envoy Gateway / Caddy цепочка:
 *   client → DO LB → ingress → pod (Nuxt nitro).
 * Ingress/Gateway проставляют XFF; trusted proxies — обязанность инфры, не
 * приложения (в h3 нет CIDR-trust как в Symfony, и в healthy k8s setup XFF
 * не подделывается извне — LB перезаписывает).
 *
 * Test-mode гейт: если `runtimeConfig.testMode` (NUXT_TEST_MODE=1) или
 * `SENTRY_DISABLED=1` — отвечаем 204 без форварда. Контекст: test-image
 * билдится с NODE_ENV=production (Dockerfile target=production), поэтому
 * client-side Sentry активен и стримит envelope'ы. Без гейта тестовые
 * прогоны попадают в прод-Sentry как реальные инциденты.
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

  const ip = getRequestIP(event, { xForwardedFor: true }) ?? ''
  const ctxUser = event.context.user as MaybeUser | undefined
  const body = enrichEnvelope(rawBody, {
    ip,
    user: {
      id: ctxUser?.id,
      email: ctxUser?.email,
      username: ctxUser?.name ?? undefined,
    },
  })

  try {
    // oxlint-disable-next-line typescript/no-unsafe-argument -- tunnelIngestUrl is a build-time string from virtual module, safe as fetch URL
    const response = await fetch(tunnelIngestUrl, {
      /* Buffer типизирован над ArrayBufferLike, BodyInit ждёт ArrayBufferView<ArrayBuffer>;
         Buffer из readRawBody/Buffer.concat всегда лежит на ArrayBuffer, не на SharedArrayBuffer. */
      body: body as Uint8Array<ArrayBuffer>,
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
