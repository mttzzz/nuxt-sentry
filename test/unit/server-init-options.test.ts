import type { Integration } from '@sentry/core'
import { describe, expect, it } from 'vitest'

import {
  buildServerIntegrations,
  buildServerSentryOptions,
  canSampleTraces,
} from '../../src/runtime/utils/server-init-options'

/* Дефолты SDK подменены именами: фильтр работает только по ним. */
const SDK_DEFAULTS = ['PostgresJs', 'Postgres', 'Http', 'Fetch', 'Dedupe', 'NodeSystemError']

function defaultsOf(names: string[]): Integration[] {
  return names.map((name) => ({ name }))
}

const INPUT = {
  dsn: 'http://key@127.0.0.1:9/1',
  release: undefined,
  enabled: true,
  cachePrefix: 'test:',
  tracesSampleRate: 0,
  queueTracesSampleRate: 0,
  ignoredRoutes: [],
}

function integrationNames(rates: { tracesSampleRate: number; queueTracesSampleRate: number }): string[] {
  const { integrations } = buildServerSentryOptions({ ...INPUT, ...rates })
  if (typeof integrations !== 'function') {
    throw new TypeError('Опции модуля обязаны отдавать integrations функцией от дефолтов SDK')
  }
  return integrations(defaultsOf(SDK_DEFAULTS)).map(({ name }) => name)
}

describe('canSampleTraces: может ли хоть один корневой спан стать транзакцией', () => {
  it.each([
    { tracesSampleRate: 0, queueTracesSampleRate: 0, expected: false },
    { tracesSampleRate: 0.1, queueTracesSampleRate: 0, expected: true },
    { tracesSampleRate: 0, queueTracesSampleRate: 0.1, expected: true },
    { tracesSampleRate: 1, queueTracesSampleRate: 1, expected: true },
    { tracesSampleRate: Number.NaN, queueTracesSampleRate: 0, expected: false },
  ])('запросы $tracesSampleRate, очереди $queueTracesSampleRate → $expected', ({ expected, ...rates }) => {
    expect(canSampleTraces(rates)).toBe(expected)
  })
})

describe('PostgresJs в серверных интеграциях', () => {
  it('трейсов нет (оба rate = 0): PostgresJs снят, остальные дефолты SDK на месте', () => {
    const names = integrationNames({ tracesSampleRate: 0, queueTracesSampleRate: 0 })

    expect(names).not.toContain('PostgresJs')
    expect(names).toEqual(expect.arrayContaining(['Postgres', 'Http']))
  })

  it.each([
    { tracesSampleRate: 0.1, queueTracesSampleRate: 0 },
    { tracesSampleRate: 0, queueTracesSampleRate: 0.1 },
    { tracesSampleRate: 1, queueTracesSampleRate: 1 },
  ])('трейсы есть (запросы $tracesSampleRate, очереди $queueTracesSampleRate): PostgresJs остаётся', (rates) => {
    expect(integrationNames(rates)).toContain('PostgresJs')
  })

  it('снятое на 11 ради поведения 10.x не возвращается ни при каких rate', () => {
    for (const rates of [
      { tracesSampleRate: 0, queueTracesSampleRate: 0 },
      { tracesSampleRate: 1, queueTracesSampleRate: 1 },
    ]) {
      const names = integrationNames(rates)
      expect(names).not.toContain('Fetch')
      expect(names).not.toContain('Dedupe')
      expect(names).not.toContain('NodeSystemError')
    }
  })

  it('buildServerIntegrations: флаг tracing решает судьбу PostgresJs напрямую', () => {
    const without = buildServerIntegrations(defaultsOf(SDK_DEFAULTS), 'test:', false).map(({ name }) => name)
    const withTracing = buildServerIntegrations(defaultsOf(SDK_DEFAULTS), 'test:', true).map(({ name }) => name)

    expect(without).not.toContain('PostgresJs')
    expect(withTracing).toContain('PostgresJs')
  })
})
