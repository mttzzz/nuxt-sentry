import type { SpanJSON } from '@sentry/core'
import { describe, expect, it } from 'vitest'

import { createPrismaSpanNormalizer, sanitizePrismaQueryText } from '../../src/runtime/utils/prisma-span-normalize'

describe('sanitizePrismaQueryText', () => {
  it('убирает `-- comment`-комментарии', () => {
    expect(sanitizePrismaQueryText('SELECT 1 -- inline comment')).toBe('SELECT 1')
  })

  it('убирает /* block */-комментарии', () => {
    expect(sanitizePrismaQueryText('/* lead */ SELECT 1 /* trail */')).toBe('SELECT 1')
  })

  it('схлопывает `IN (?, ?, ?)` → `IN (?)`', () => {
    expect(sanitizePrismaQueryText('SELECT * FROM t WHERE id IN (?, ?, ?, ?, ?)')).toBe('SELECT * FROM t WHERE id IN (?)')
  })

  it('схлопывает CONCAT(?, ?, ?) → CONCAT(?)', () => {
    expect(sanitizePrismaQueryText('SELECT CONCAT(?, ?, ?) AS x')).toBe('SELECT CONCAT(?) AS x')
  })

  it('убирает trailing `;` и схлопывает whitespace', () => {
    expect(sanitizePrismaQueryText('SELECT  1\n  FROM   t  ;  ')).toBe('SELECT 1 FROM t')
  })

  it('заменяет `%s` → `?`', () => {
    expect(sanitizePrismaQueryText('SELECT %s FROM t')).toBe('SELECT ? FROM t')
  })
})

describe('createPrismaSpanNormalizer', () => {
  function span(partial: Partial<SpanJSON>): SpanJSON {
    return {
      data: {},
      span_id: 'sid',
      trace_id: 'tid',
      start_timestamp: 0,
      ...partial,
    } as SpanJSON
  }

  it('пропускает не-Prisma spans без изменений', () => {
    const fn = createPrismaSpanNormalizer()
    const input = span({ description: 'GET /api/foo', data: { 'db.query.text': 'SELECT 1' } })
    expect(fn(input)).toBe(input)
  })

  it('Prisma-span с raw queryText: санитизирует и проставляет op/origin/db.system', () => {
    const fn = createPrismaSpanNormalizer({ databaseSystem: 'mysql' })
    const result = fn(span({
      description: 'prisma:engine:query',
      origin: 'auto.db.otel.prisma',
      data: { 'db.query.text': 'SELECT * FROM t WHERE id IN (?, ?, ?)', 'db.system': 'prisma' },
    }))
    expect(result.description).toBe('SELECT * FROM t WHERE id IN (?)')
    expect(result.op).toBe('db')
    expect(result.data?.['db.system']).toBe('mysql')
    expect(result.data?.['db.system.name']).toBe('mysql')
    expect(result.data?.['sentry.op']).toBe('db')
    expect(result.data?.['sentry.origin']).toBe('auto.db.otel.prisma')
  })

  it('сохраняет `db.system.name` если он задан и не равен "prisma"', () => {
    const fn = createPrismaSpanNormalizer({ databaseSystem: 'mysql' })
    const result = fn(span({
      description: 'prisma:engine:query',
      data: { 'db.query.text': 'SELECT 1', 'db.system.name': 'postgresql' },
    }))
    expect(result.data?.['db.system']).toBe('postgresql')
  })

  it('пропускает Prisma-span без queryText', () => {
    const fn = createPrismaSpanNormalizer()
    const input = span({ description: 'prisma:client:connect', data: {} })
    expect(fn(input)).toBe(input)
  })
})
