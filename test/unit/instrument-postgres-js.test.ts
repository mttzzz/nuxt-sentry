import { describe, expect, it, vi } from 'vitest'

import { instrumentPostgresJs } from '../../src/runtime/utils/instrument-postgres-js'

/*
 * Юнит-тесты для тонкой обёртки над `Sentry.instrumentPostgresJsSql`.
 * Цель — проверить контракт: Drizzle совместимость (через .options и т.п.),
 * пас-thru для невалидных входов, идемпотентность. Сам span-creation
 * проверяется в @sentry/core upstream — не дублируем.
 */

type FakeSql = ((...args: unknown[]) => unknown) & {
  options: { parsers: Record<string, unknown>, serializers: Record<string, unknown>, host: string[], port: number[], database: string }
  unsafe: (...args: unknown[]) => unknown
  begin: (...args: unknown[]) => unknown
}

function makeFakeSql(): FakeSql {
  const sql = vi.fn() as unknown as FakeSql
  sql.options = {
    parsers: {},
    serializers: {},
    host: ['localhost'],
    port: [5432],
    database: 'test',
  }
  sql.unsafe = vi.fn() as unknown as FakeSql['unsafe']
  sql.begin = vi.fn() as unknown as FakeSql['begin']
  return sql
}

describe('instrumentPostgresJs', () => {
  it('non-function input возвращается как есть (safety)', () => {
    /* @sentry/core возвращает sql как есть, если это не функция — Drizzle такой
       инстанс всё равно не примет, мы просто не падаем. */
    expect(instrumentPostgresJs(null as never)).toBeNull()
    expect(instrumentPostgresJs(undefined as never)).toBeUndefined()
    expect(instrumentPostgresJs({} as never)).toEqual({})
  })

  it('function input оборачивается в Proxy (новая ссылка)', () => {
    const sql = makeFakeSql()
    const wrapped = instrumentPostgresJs(sql)
    expect(wrapped).not.toBe(sql)
    expect(typeof wrapped).toBe('function')
  })

  it('доступ к .options проходит через Proxy к оригинальному объекту (Drizzle мутирует parsers/serializers)', () => {
    const sql = makeFakeSql()
    const wrapped = instrumentPostgresJs(sql)
    /* Drizzle делает client.options.parsers['1184'] = transparentParser в driver.ts */
    wrapped.options.parsers['1184'] = 'parser'
    expect(sql.options.parsers['1184']).toBe('parser')
  })

  it('идемпотентность: повторная обёртка не создаёт двойной Proxy', () => {
    const sql = makeFakeSql()
    const once = instrumentPostgresJs(sql)
    const twice = instrumentPostgresJs(once)
    /* Sentry использует Symbol.for('sentry.instrumented.postgresjs') marker
       чтобы не оборачивать второй раз — должен вернуться тот же proxy. */
    expect(twice).toBe(once)
  })

  it('доступ к не-перехваченным методам возвращает оригинальные функции (sql.unsafe для prepare query Drizzle)', () => {
    const sql = makeFakeSql()
    const wrapped = instrumentPostgresJs(sql)
    /* `unsafe` оборачивается отдельно (создаётся новая функция-обёртка),
       но должна быть функцией и звать оригинал. */
    expect(typeof wrapped.unsafe).toBe('function')
    wrapped.unsafe('SELECT 1', [], { prepare: true })
    expect(vi.mocked(sql.unsafe)).toHaveBeenCalledWith('SELECT 1', [], { prepare: true })
  })
})
