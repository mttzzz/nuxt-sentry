import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

/*
 * PostgresJs на настоящем Sentry 11 под Bun: подписан ли кто-нибудь на канал `postgres:query`. Пока подписчик есть,
 * postgres ≥ 4 строит контекст каждого запроса, а интеграция разбирает его текст — даже когда спан не пишется (замер:
 * README, «PostgresJs и трейсы»). Фикстура поднимает `Sentry.init` с опциями модуля отдельным процессом.
 */

interface Outcome {
  integrations: string[]
  subscribed: boolean
  probeCaptured: boolean
  channelWarningCaptured: boolean
}

const FIXTURE = fileURLToPath(new URL('../fixtures/sentry-traffic/server-postgres-channel.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function run(tracesSampleRate: number, queueTracesSampleRate: number): Outcome {
  const proc = spawnSync(
    process.versions.bun ? process.execPath : 'bun',
    [FIXTURE, String(tracesSampleRate), String(queueTracesSampleRate)],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
  )
  if (proc.status !== 0) {
    throw new Error(`Фикстура упала (status=${String(proc.status)}): ${proc.stderr.slice(-2000)}`)
  }
  return JSON.parse(proc.stdout) as Outcome
}

let tracesOff: Outcome
let requestTraces: Outcome
let queueTraces: Outcome

beforeAll(() => {
  tracesOff = run(0, 0)
  requestTraces = run(0.1, 0)
  queueTraces = run(0, 0.1)
})

describe('канал postgres:query и интеграция PostgresJs', () => {
  it('трейсов нет: интеграции нет и на канал никто не подписан — postgres не строит контекст запроса', () => {
    expect(tracesOff.integrations).not.toContain('PostgresJs')
    expect(tracesOff.subscribed).toBe(false)
  })

  it('трейсы запросов включены: PostgresJs стоит и подписан на канал', () => {
    expect(requestTraces.integrations).toContain('PostgresJs')
    expect(requestTraces.subscribed).toBe(true)
  })

  it('включены только трейсы очередей: PostgresJs остаётся — db-спаны нужны внутри их транзакций', () => {
    expect(queueTraces.integrations).toContain('PostgresJs')
    expect(queueTraces.subscribed).toBe(true)
  })
})

describe('предупреждение Sentry про инъекцию диагностических каналов на Bun (11.12+)', () => {
  /* Решение: принять, не гасить. Bun 1.4 не умеет инжект во время работы (нет Module.registerHooks), поэтому строка в
     stderr будет всегда; важно, что она не становится issue в Sentry. */
  it('обычный console.warn становится событием (контроль), а предупреждение про каналы — нет', () => {
    expect(tracesOff.probeCaptured).toBe(true)
    expect(tracesOff.channelWarningCaptured).toBe(false)
    expect(requestTraces.channelWarningCaptured).toBe(false)
  })
})
