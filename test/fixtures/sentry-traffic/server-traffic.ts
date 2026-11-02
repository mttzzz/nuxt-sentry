import { createServer, request as httpRequest } from 'node:http'

/*
 * Опыт «ловушка DSN» для server-sentry-traffic.test.ts: настоящий `Sentry.init` с опциями модуля
 * (buildServerSentryOptions), настоящий Bun.serve и node:http внутри процесса, приёмник конвертов вместо
 * Sentry и «внешний сервис», записывающий заголовки исходящих запросов. Печатает JSON-сводку в stdout.
 *
 * Запускается ПОД BUN отдельным процессом: Sentry.init патчит Bun.serve и globalThis.fetch на весь процесс,
 * и в воркере vitest этого делать нельзя. Приёмник и «внешний сервис» создаются ДО init — их Bun.serve не
 * инструментируется.
 */
import * as Sentry from '@sentry/bun'
import type { Integration } from '@sentry/core'

import { captureNitroError } from '../../../src/runtime/utils/capture-nitro-error'
import { buildServerSentryOptions } from '../../../src/runtime/utils/server-init-options'

interface Received {
  headers: Record<string, string>
  body: string
}

interface Summary {
  envelopes: { items: { header: { type: string }; payload: unknown }[] }[]
  external: { method: string; url: string; headers: Record<string, string> }[]
  requestSessionStarts: number
  innerRequestBody: unknown
  /* Итоговая конфигурация клиента — как её видит SDK после init, а не как мы её передали. */
  config: {
    options: Record<string, unknown>
    optionKeys: string[]
    dataCollection: unknown
    integrations: string[]
    bunServerRequestOptions: unknown
  }
}

const trapEnvelopes: Received[] = []
const external: Summary['external'] = []

const trap = Bun.serve({
  port: 0,
  async fetch(request) {
    trapEnvelopes.push({
      headers: Object.fromEntries(request.headers.entries()),
      body: await request.text(),
    })
    return new Response('{}')
  },
})
const externalService = Bun.serve({
  port: 0,
  async fetch(request) {
    await request.arrayBuffer()
    const url = new URL(request.url)
    external.push({
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers.entries()),
    })
    return new Response('ok')
  },
})

Sentry.init({
  ...buildServerSentryOptions({
    dsn: `http://key@127.0.0.1:${String(trap.port)}/1`,
    release: 'traffic-test',
    enabled: true,
    cachePrefix: 'traffic:',
    tracesSampleRate: 0,
    queueTracesSampleRate: 0,
    ignoredRoutes: [],
  }),
})

const client = Sentry.getClient()
if (!client) {
  throw new Error('Sentry client was not created')
}

/* Сессия запроса стартует через хук клиента: считаем старты на ВСЕХ путях (Bun.serve и node:http). */
let requestSessionStarts = 0
client.on('startRequestSession', () => {
  requestSessionStarts += 1
})

/* Агрегаты сессий уходят раз в 60 с — окно теста короче. Если бы сессии были включены, сброс нужен в пределах
   окна, иначе проверка «сессий нет» проходила бы вхолостую. Сброс читается из опций интеграции на каждый запрос. */
const bunServer = client.getIntegrationByName<Integration & { requestOptions: { sessionFlushingDelayMS?: number } }>(
  'BunServer',
)
if (bunServer) {
  bunServer.requestOptions.sessionFlushingDelayMS = 200
}

let innerRequestBody: unknown = null

async function callExternal(base: string): Promise<void> {
  /* Исходящий fetch на «шлюз моделей/платёжку/S3». */
  const response = await fetch(`${base}/ext-fetch?token=abc&x=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ext-token' },
    body: JSON.stringify({ payment: '4111111111111111' }),
  })
  await response.text()
  /* Исходящий node:http(s): aws-sdk/S3, assert-public-url. */
  const target = new URL(`${base}/ext-http?y=2`)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const outgoing = httpRequest(
    { host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET' },
    (incoming) => {
      incoming.resume()
      incoming.on('end', () => resolve())
    },
  )
  outgoing.on('error', reject)
  outgoing.end()
  await promise
}

/* node:http-сервер внутри процесса (создан ПОСЛЕ init): запрос с телом, cookie и authorization. */
async function callInnerNodeHttpServer(): Promise<void> {
  const { promise: listening, resolve: onListening } = Promise.withResolvers<void>()
  const inner = createServer((request, response) => {
    /* Изоляционный scope запроса берём синхронно, пока он активен: тело доезжает позже, в 'end'. */
    const scope = Sentry.getIsolationScope()
    request.on('data', () => {})
    request.on('end', () => {
      innerRequestBody = scope.getScopeData().sdkProcessingMetadata.normalizedRequest ?? null
      response.end('ok')
    })
  })
  inner.listen(0, '127.0.0.1', () => onListening())
  await listening
  const address = inner.address()
  if (address === null || typeof address === 'string') {
    throw new Error('inner server has no port')
  }
  const reply = await fetch(`http://127.0.0.1:${String(address.port)}/inner?secret=1`, {
    method: 'POST',
    headers: {
      cookie: 'session=INNER-SESSION',
      authorization: 'Bearer inner-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password: 'INNER-PASSWORD' }),
  })
  await reply.text()
  inner.close()
}

const app = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const headers = Object.fromEntries(request.headers.entries())
    if (url.pathname === '/echo') {
      await request.text()
      await callExternal(`http://127.0.0.1:${String(externalService.port)}`)
      /* Ровно то, что делает plugin-user-context.ts на запросе. */
      Sentry.setUser({ id: 'u1', email: 'u1@example.com', username: 'user one', ip_address: '203.0.113.9' })
      captureNitroError(new Error('boom-nitro'), {
        event: {
          path: url.pathname,
          method: request.method,
          node: { req: { url: url.pathname, method: request.method, headers } },
        },
      })
      return new Response('error', { status: 500 })
    }
    if (url.pathname === '/throw') {
      throw new Error('boom-uncaught')
    }
    if (url.pathname === '/log') {
      console.error('[traffic] error log', new Error('log-err'))
      console.warn('[traffic] warn without error object')
      Sentry.captureMessage('traffic direct message', { level: 'warning', fingerprint: ['traffic-message'] })
      return new Response('logged')
    }
    if (url.pathname === '/dup') {
      for (let index = 0; index < 3; index += 1) {
        console.error('[traffic] dup', new Error('dup-same'))
      }
      return new Response('dup')
    }
    if (url.pathname === '/inner') {
      await callInnerNodeHttpServer()
      return new Response('inner')
    }
    return new Response('not found', { status: 404 })
  },
})

const clientHeaders = {
  cookie: 'session=SESSIONSECRET; theme=dark',
  authorization: 'Bearer client-token-123',
  'x-forwarded-for': '203.0.113.9',
  'user-agent': 'traffic-test/1.0',
  'content-type': 'application/json',
}
const base = `http://127.0.0.1:${String(app.port)}`
await (
  await fetch(`${base}/echo?q=search&token=qtoken`, {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ password: 'S3CRET-PASSWORD', note: 'hello' }),
  })
).text()
await (await fetch(`${base}/throw`, { headers: clientHeaders })).text()
await (await fetch(`${base}/log`, { headers: clientHeaders })).text()
await (await fetch(`${base}/dup`, { headers: clientHeaders })).text()
await (await fetch(`${base}/inner`, { headers: clientHeaders })).text()
/* OPTIONS — отдельный путь Bun-интеграции: ошибки в нём ловятся, но сессия не стартует. */
await (await fetch(`${base}/echo`, { method: 'OPTIONS', headers: clientHeaders })).text()

await Sentry.flush(3000)
/* Окно для отложенных агрегатов сессий (200 мс сброс) и транспорта. */
await Bun.sleep(1200)
await Sentry.flush(3000)

function parseEnvelope(raw: string): Summary['envelopes'][number] {
  const lines = raw.split('\n').filter(Boolean)
  const items: Summary['envelopes'][number]['items'] = []
  for (let index = 1; index < lines.length; index += 2) {
    items.push({
      header: JSON.parse(lines[index] ?? '{}') as { type: string },
      payload: JSON.parse(lines[index + 1] ?? 'null') as unknown,
    })
  }
  return { items }
}

const clientOptions = client.getOptions()
const summary: Summary = {
  envelopes: trapEnvelopes.map((received) => parseEnvelope(received.body)),
  external,
  requestSessionStarts,
  innerRequestBody,
  config: {
    options: {
      attachStacktrace: clientOptions.attachStacktrace,
      normalizeDepth: clientOptions.normalizeDepth,
      tracePropagationTargets: clientOptions.tracePropagationTargets,
      release: clientOptions.release,
      debug: clientOptions.debug,
      enableRuntimeChannelInjection: (clientOptions as { enableRuntimeChannelInjection?: boolean })
        .enableRuntimeChannelInjection,
    },
    optionKeys: Object.keys(clientOptions),
    dataCollection: client.getDataCollectionOptions(),
    integrations: (clientOptions.integrations ?? []).map((integration) => integration.name),
    bunServerRequestOptions: bunServer?.requestOptions ?? null,
  },
}
process.stdout.write(`${JSON.stringify(summary)}\n`)

app.stop(true)
trap.stop(true)
externalService.stop(true)
process.exit(0)
