import { tracingChannel } from 'node:diagnostics_channel'

import * as Sentry from '@sentry/bun'

import { buildServerSentryOptions } from '../../../src/runtime/utils/server-init-options'

/*
 * Опыт «PostgresJs и трейсы» для server-postgres-js.test.ts: настоящий `Sentry.init` с опциями модуля и частотами из
 * argv (запросы, очереди). Печатает JSON-сводку: какие интеграции стоят, подписан ли кто-нибудь на канал
 * `postgres:query` (его postgres ≥ 4 публикует на каждый запрос) и что стало событием Sentry.
 *
 * Запускается ПОД BUN отдельным процессом: Sentry.init патчит процесс целиком.
 */
const [tracesArg = '0', queueArg = '0'] = process.argv.slice(2)
const events: string[] = []

const options = buildServerSentryOptions({
  dsn: 'http://key@127.0.0.1:9/1',
  release: 'postgres-channel',
  enabled: true,
  cachePrefix: 'channel:',
  tracesSampleRate: Number(tracesArg),
  queueTracesSampleRate: Number(queueArg),
  ignoredRoutes: [],
})

/* События ловим до отправки: сети нет, и приёмник DSN не нужен. */
Sentry.init({
  ...options,
  beforeSend(event) {
    events.push(JSON.stringify(event))
    return null
  },
})

/* Подписка интеграций на каналы ждёт готовности стратегии async-контекста: даём ей несколько тиков. */
await Bun.sleep(100)

/* Контроль: обычное предупреждение ловится captureConsoleIntegration и становится событием. */
// oxlint-disable-next-line no-console -- Контроль канала захвата консоли
console.warn('[probe] plain warn')
await Sentry.flush(1000)

const channel = tracingChannel('postgres:query')
process.stdout.write(
  `${JSON.stringify({
    integrations: (Sentry.getClient()?.getOptions().integrations ?? []).map(({ name }) => name),
    subscribed: Boolean(channel.start.hasSubscribers || channel.end.hasSubscribers || channel.asyncEnd.hasSubscribers),
    probeCaptured: events.some((event) => event.includes('[probe] plain warn')),
    channelWarningCaptured: events.some((event) => event.includes('diagnostics-channel')),
  })}\n`,
)
process.exit(0)
