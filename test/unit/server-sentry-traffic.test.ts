import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

/*
 * Что серверный Sentry на самом деле отправляет и куда ходит процесс — опытом, а не чтением опций:
 * фикстура server-traffic.ts поднимает настоящий `Sentry.init` с опциями модуля (buildServerSentryOptions),
 * Bun.serve и node:http внутри процесса, приёмник конвертов (ловушка DSN) и «внешний сервис». Под Bun отдельным
 * процессом: init патчит Bun.serve и globalThis.fetch на весь процесс.
 *
 * Мониторинг на Sentry 11 обязан остаться таким, каким был на 10.x (на 11 без правок в этом же прогоне были:
 * тело POST с паролем в request.data, sentry-trace/baggage во всех исходящих fetch, агрегаты request-сессий,
 * дедуп подряд идущих одинаковых событий; на 10.x и 11 — сырые cookie/authorization в extra.headers).
 */

interface EnvelopeItem {
  header: { type: string }
  payload: Record<string, unknown>
}
interface TrafficEvent {
  message?: string
  exception?: { values?: { value?: string; mechanism?: { type?: string }; stacktrace?: { frames?: unknown[] } }[] }
  threads?: unknown
  contexts?: Record<string, unknown>
  request?: {
    url?: string
    headers?: Record<string, string>
    cookies?: Record<string, string>
    data?: unknown
    query_string?: string
  }
  user?: { id?: string; email?: string; username?: string; ip_address?: string }
  extra?: Record<string, unknown>
}
interface Traffic {
  envelopes: { items: EnvelopeItem[] }[]
  external: { method: string; url: string; headers: Record<string, string> }[]
  requestSessionStarts: number
  innerRequestBody: unknown
  config: {
    options: Record<string, unknown>
    optionKeys: string[]
    dataCollection: unknown
    integrations: string[]
    bunServerRequestOptions: unknown
  }
}

const FIXTURE = fileURLToPath(new URL('../fixtures/sentry-traffic/server-traffic.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

let traffic: Traffic
let items: EnvelopeItem[]
let events: TrafficEvent[]

function eventByException(value: string): TrafficEvent {
  const found = events.find((event) => event.exception?.values?.some((entry) => entry.value === value))
  if (!found) {
    throw new Error(
      `событие «${value}» не дошло до ловушки; пришли: ${JSON.stringify(events.map((e) => e.exception?.values?.[0]?.value ?? e.message))}`,
    )
  }
  return found
}

beforeAll(() => {
  const run = spawnSync(process.versions.bun ? process.execPath : 'bun', [FIXTURE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.status !== 0) {
    throw new Error(`фикстура упала (status=${String(run.status)}): ${run.stderr.slice(-2000)}`)
  }
  traffic = JSON.parse(run.stdout) as Traffic
  items = traffic.envelopes.flatMap((envelope) => envelope.items)
  events = items.filter((item) => item.header.type === 'event').map((item) => item.payload as TrafficEvent)
})

describe('серверный Sentry: итоговая конфигурация клиента (как её видит SDK после init)', () => {
  it('опции: стек у captureMessage, глубина, пропагация трассировки наружу выключена, инжект каналов выключен', () => {
    expect(traffic.config.options).toMatchObject({
      attachStacktrace: true,
      normalizeDepth: 8,
      tracePropagationTargets: [],
      release: 'traffic-test',
      debug: false,
      enableRuntimeChannelInjection: false,
    })
  })

  it('удалённые в 11 опции не передаются: sendDefaultPii, enableLogs', () => {
    expect(traffic.config.optionKeys).not.toContain('sendDefaultPii')
    expect(traffic.config.optionKeys).not.toContain('enableLogs')
  })

  it('политика сбора данных: user/IP, cookie, заголовки, query — как на 10.x с sendDefaultPii; тела, очереди и MCP — нет', () => {
    expect(traffic.config.dataCollection).toEqual({
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
    })
  })

  it('интеграции: новые умолчания 11 с побочными эффектами сняты, нужные на месте', () => {
    expect(traffic.config.integrations).not.toContain('Fetch')
    expect(traffic.config.integrations).not.toContain('Dedupe')
    expect(traffic.config.integrations).not.toContain('NodeSystemError')
    expect(traffic.config.integrations).toEqual(
      expect.arrayContaining([
        'BunServer',
        'BunHttpServer',
        'CaptureConsole',
        'Redis',
        'OtelEventTrace',
        'Http',
        'RequestData',
        'ProcessSession',
        'OnUncaughtException',
        'OnUnhandledRejection',
      ]),
    )
  })

  it('Bun.serve: тела не читаются, request-сессии выключены', () => {
    expect(traffic.config.bunServerRequestOptions).toMatchObject({ maxRequestBodySize: 'none', sessions: false })
  })
})

describe('серверный Sentry: события уходят, как на 10.x', () => {
  it('ошибка nitro-хука, необработанная ошибка обработчика и console.error доходят до ловушки', () => {
    expect(eventByException('boom-nitro').exception?.values?.[0]?.mechanism?.type).toBe('nitro')
    expect(eventByException('boom-uncaught').exception?.values?.[0]?.mechanism?.type).toBe('auto.http.bun.serve')
    expect(eventByException('log-err').exception?.values?.[0]?.mechanism?.type).toBe('auto.core.capture_console')
    expect(events.some((event) => event.message === '[traffic] warn without error object')).toBe(true)
  })

  it('captureMessage несёт синтетический стек (attachStacktrace: true) и заголовок — текст сообщения', () => {
    const message = events.find((event) => event.message === 'traffic direct message')
    expect(message).toBeDefined()
    expect(message?.exception).toBeUndefined()
    expect(message?.threads).toBeDefined()
  })

  it('дедуп отключён: три подряд одинаковых console.error — три события (на 10.x сервер дедупа не имел)', () => {
    const duplicates = events.filter((event) => event.exception?.values?.some((entry) => entry.value === 'dup-same'))
    expect(duplicates).toHaveLength(3)
  })

  it('системная ошибка (ENOENT): путь остаётся в заголовке, как на 10.x, и contexts.node_system_error не добавляется', () => {
    const entry = events
      .flatMap((event) => (event.exception?.values ?? []).map((value) => ({ event, value })))
      .find(({ value }) => value.value?.includes('no such file or directory'))
    expect(entry, 'событие ENOENT не дошло до ловушки').toBeDefined()
    expect(entry?.value.value).toContain("'/definitely/missing/traffic-file.txt'")
    expect(entry?.event.contexts).not.toHaveProperty('node_system_error')
  })

  it('id, email и IP пользователя из plugin-user-context на месте (user.ip_address и из X-Forwarded-For SDK)', () => {
    expect(eventByException('boom-nitro').user).toMatchObject({
      id: 'u1',
      email: 'u1@example.com',
      username: 'user one',
      ip_address: '203.0.113.9',
    })
    expect(eventByException('boom-uncaught').user?.ip_address).toBe('203.0.113.9')
  })

  it('прочие заголовки и cookie без секретов — как на 10.x: имена cookie, user-agent, x-forwarded-for, query', () => {
    const { request } = eventByException('boom-nitro')
    expect(request?.headers?.['user-agent']).toBe('traffic-test/1.0')
    expect(request?.headers?.['x-forwarded-for']).toBe('203.0.113.9')
    expect(request?.cookies).toEqual({ session: '[Filtered]', theme: 'dark' })
    expect(request?.query_string).toBe('q=search&token=[Filtered]')
  })
})

describe('серверный Sentry: секреты не уходят', () => {
  it('cookie сессии и authorization — [Filtered] в request.headers и request.cookies', () => {
    for (const event of [eventByException('boom-nitro'), eventByException('boom-uncaught')]) {
      expect(event.request?.headers?.authorization).toBe('[Filtered]')
      expect(event.request?.headers?.cookie).toBe('[Filtered]')
      expect(event.request?.cookies?.session).toBe('[Filtered]')
    }
  })

  it('extra.headers nitro-события (строка JSON из buildSentryReport) тоже без сырых секретов', () => {
    const headers = JSON.parse(String(eventByException('boom-nitro').extra?.headers)) as Record<string, string>
    expect(headers.authorization).toBe('[Filtered]')
    expect(headers.cookie).toBe('[Filtered]')
    expect(headers['x-forwarded-for']).toBe('203.0.113.9')
  })

  it('ни одно значение секрета не встречается нигде в трафике к Sentry', () => {
    const wire = JSON.stringify(traffic.envelopes)
    for (const secret of ['SESSIONSECRET', 'client-token-123', 'INNER-SESSION', 'inner-token', 'qtoken']) {
      expect(wire, secret).not.toContain(secret)
    }
  })
})

describe('серверный Sentry: тела запросов не собираются', () => {
  it('request.data нет ни у одного события, пароль из тела POST не уходит нигде', () => {
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.request?.data).toBeUndefined()
    }
    const wire = JSON.stringify(traffic.envelopes)
    expect(wire).not.toContain('S3CRET-PASSWORD')
    expect(wire).not.toContain('INNER-PASSWORD')
  })

  it('node:http-сервер внутри процесса: тело не читается (normalizedRequest без data)', () => {
    expect(traffic.innerRequestBody).not.toBeNull()
    expect(traffic.innerRequestBody).not.toHaveProperty('data')
  })
})

describe('серверный Sentry: сессии как на 10.x', () => {
  it('request-сессий нет: ни одного старта на Bun.serve и node:http, ни одного агрегата sessions', () => {
    expect(traffic.requestSessionStarts).toBe(0)
    expect(items.filter((item) => item.header.type === 'sessions')).toEqual([])
  })

  it('процессная сессия (processSessionIntegration) остаётся одна, как на 10.x', () => {
    expect(items.filter((item) => item.header.type === 'session')).toHaveLength(1)
  })
})

describe('исходящие запросы не несут заголовков трассировки Sentry', () => {
  it('fetch и node:http на внешний адрес — без sentry-trace и baggage', () => {
    expect(traffic.external.map((request) => request.url).toSorted()).toEqual([
      '/ext-fetch?token=abc&x=1',
      '/ext-fetch?token=abc&x=1',
      '/ext-http?y=2',
      '/ext-http?y=2',
    ])
    for (const request of traffic.external) {
      expect(request.headers['sentry-trace'], request.url).toBeUndefined()
      expect(request.headers.baggage, request.url).toBeUndefined()
      expect(request.headers.traceparent, request.url).toBeUndefined()
    }
  })

  it('breadcrumb про исходящий fetch в события не попадает (на 10.x под Bun его не было)', () => {
    const breadcrumbs = events.flatMap(
      (event) => (event as { breadcrumbs?: { category?: string }[] }).breadcrumbs ?? [],
    )
    expect(breadcrumbs.filter((crumb) => crumb.category === 'fetch')).toEqual([])
  })
})
