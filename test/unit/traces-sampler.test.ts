import { describe, expect, it } from 'vitest'

import { createTracesSampler } from '../../src/runtime/utils/traces-sampler'

/* Разные rate'ы: по возвращённому числу видно, какое именно правило сработало. */
const TRACES_RATE = 0.1
const QUEUE_RATE = 0.3

/* Список ignoredRoutes — дефолт модуля (src/module.ts DEFAULTS). */
const sample = createTracesSampler({
  tracesSampleRate: TRACES_RATE,
  queueTracesSampleRate: QUEUE_RATE,
  ignoredRoutes: ['/api/sentry-tunnel', '/_nuxt', '/api/ws', '/api/health', '/__nuxt_error'],
})

/* Контексты ниже — то, что Sentry отдаёт tracesSampler для КОРНЕВЫХ спанов (замер на @sentry/bun
 * 10.75.3, ai.pushka.biz): корневая Redis-команда приходит как `redis-<cmd>` с sentry.op db.redis,
 * запрос Bun.serve — как `GET /api/ws` с sentry.op http.server и url.path. */
describe('createTracesSampler — корневые db/cache-спаны', () => {
  it('корневая Redis-команда (опрос bull, op db.redis) → 0', () => {
    expect(sample({ name: 'redis-brpoplpush', attributes: { 'sentry.op': 'db.redis', 'db.system': 'redis' } })).toBe(0)
  })

  it('Redis connect (op db.redis.connect) → 0', () => {
    expect(sample({ name: 'redis-connect', attributes: { 'sentry.op': 'db.redis.connect' } })).toBe(0)
  })

  it('корневой запрос в postgres (op db) → 0', () => {
    expect(sample({ name: 'select 1', attributes: { 'sentry.op': 'db', 'db.system': 'postgresql' } })).toBe(0)
  })

  it('корневая cache-операция (op cache.get) → 0', () => {
    expect(sample({ name: 'myapp-cache:threads', attributes: { 'sentry.op': 'cache.get' } })).toBe(0)
  })

  it('op, лишь начинающийся на db/cache, но не сегмент db./cache., не гасится', () => {
    for (const op of ['dbsync', 'database', 'cache-warmup', 'cachekeys']) {
      expect(sample({ name: 'custom-job', attributes: { 'sentry.op': op } }), op).toBe(TRACES_RATE)
    }
  })

  it('task-корень (cron через defineSentryTask) → дефолтный rate', () => {
    expect(sample({ name: 'amo-sync', attributes: { 'sentry.op': 'task', 'task.name': 'amo-sync' } })).toBe(TRACES_RATE)
  })
})

describe('createTracesSampler — очереди', () => {
  /* Корень, который создаёт sentry-queue.ts: startSpan({ name: 'queue.…/<очередь>' }) без op. */
  it('queue.process/<очередь> → queueTracesSampleRate', () => {
    expect(sample({ name: 'queue.process/mail', attributes: { 'sentry.origin': 'manual' } })).toBe(QUEUE_RATE)
  })

  it('queue.publish/<очередь> → queueTracesSampleRate', () => {
    expect(sample({ name: 'queue.publish/mail' })).toBe(QUEUE_RATE)
  })
})

describe('createTracesSampler — ignoredRoutes', () => {
  it('GET /api/ws по url.path → 0', () => {
    expect(sample({ name: 'GET /api/ws', attributes: { 'sentry.op': 'http.server', 'url.path': '/api/ws' } })).toBe(0)
  })

  it('POST /api/sentry-tunnel без url.path: путь берётся из имени без метода → 0', () => {
    expect(sample({ name: 'POST /api/sentry-tunnel', attributes: { 'sentry.op': 'http.server' } })).toBe(0)
  })

  it('имя без атрибутов: метод срезается, путь сверяется со всем списком', () => {
    for (const name of [
      'GET /_nuxt/entry.abc123.js',
      'GET /api/health/ready',
      'GET /__nuxt_error',
      'OPTIONS /api/ws',
    ]) {
      expect(sample({ name }), name).toBe(0)
    }
  })

  it('имя-путь без метода (кастомный спан) тоже сверяется', () => {
    expect(sample({ name: '/api/health/ready' })).toBe(0)
  })

  it('обычный маршрут → дефолтный rate', () => {
    expect(
      sample({
        name: 'GET /api/threads/abc',
        attributes: { 'sentry.op': 'http.server', 'url.path': '/api/threads/abc' },
      }),
    ).toBe(TRACES_RATE)
  })

  it('url.path главнее имени, если они расходятся', () => {
    expect(sample({ name: 'GET /api/ws', attributes: { 'url.path': '/api/threads/abc' } })).toBe(TRACES_RATE)
  })

  it('url.path не строка → путь берётся из имени', () => {
    for (const urlPath of [undefined, 42]) {
      expect(sample({ name: 'GET /api/ws', attributes: { 'url.path': urlPath } }), String(urlPath)).toBe(0)
    }
  })

  it('без имени и атрибутов → дефолтный rate', () => {
    expect(sample({})).toBe(TRACES_RATE)
  })

  /* Сравнение — префикс строки (как и раньше), а не граница сегмента: `/_nuxt` из дефолтов обязан гасить
   * всё поддерево `/_nuxt/*`, а `/api/health` — `/api/health/ready`. Следствие: соседний маршрут с общим
   * префиксом (`/api/wsx`) гасится тоже, а точное совпадение этим списком не выразить. */
  it('ignoredRoutes — префиксы строки: общий префикс гасится, середина пути и короткий хвост нет', () => {
    expect(sample({ name: 'GET /api/wsx', attributes: { 'url.path': '/api/wsx' } })).toBe(0)
    expect(sample({ name: 'GET /api/threads/ws', attributes: { 'url.path': '/api/threads/ws' } })).toBe(TRACES_RATE)
    expect(sample({ name: 'GET /api/w', attributes: { 'url.path': '/api/w' } })).toBe(TRACES_RATE)
  })

  it('использует переданный список ignoredRoutes, а не зашитый', () => {
    const custom = createTracesSampler({
      tracesSampleRate: TRACES_RATE,
      queueTracesSampleRate: QUEUE_RATE,
      ignoredRoutes: ['/internal'],
    })
    expect(custom({ name: 'GET /internal/metrics', attributes: { 'url.path': '/internal/metrics' } })).toBe(0)
    expect(custom({ name: 'GET /api/ws', attributes: { 'url.path': '/api/ws' } })).toBe(TRACES_RATE)
  })

  it('пустой ignoredRoutes → маршруты не гасятся, db/cache-корни по-прежнему гасятся', () => {
    const open = createTracesSampler({
      tracesSampleRate: TRACES_RATE,
      queueTracesSampleRate: QUEUE_RATE,
      ignoredRoutes: [],
    })
    expect(open({ name: 'GET /api/ws', attributes: { 'url.path': '/api/ws' } })).toBe(TRACES_RATE)
    expect(open({ name: 'redis-xread', attributes: { 'sentry.op': 'db.redis' } })).toBe(0)
  })
})
