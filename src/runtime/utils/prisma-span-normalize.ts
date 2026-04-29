import type { SpanJSON } from '@sentry/core'

/*
 * Нормализация Prisma-spans для Sentry beforeSendSpan:
 *   - санитизирует `db.query.text` (убирает SQL-комментарии, схлопывает whitespace,
 *     дедупит `IN (?,?,?)` → `IN (?)`, `CONCAT(?,?,?)` → `CONCAT(?)`),
 *   - нормализует `db.system` / `db.system.name` к корректному имени БД (default 'mysql').
 *
 * Зачем: Prisma-instrumentation эмитит spans с raw query text (bind-params уже как `?`,
 * но array-параметры разворачиваются в `IN (?, ?, ?, ...)` с переменным числом плейсхолдеров).
 * Без дедупа Sentry агрегирует их как разные fingerprint'ы → шум в performance issue list.
 */

const PRISMA_DEFAULT_DATABASE_SYSTEM = 'mysql'

export function sanitizePrismaQueryText(queryText: string): string {
  return queryText
    .replaceAll(/--.*$/gm, '')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replace(/;\s*$/, '')
    .replaceAll('%s', '?')
    .replaceAll(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'IN (?)')
    .replaceAll(/\bCONCAT\(\s*\?(?:\s*,\s*\?)+\s*\)/gi, 'CONCAT(?)')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

export function createPrismaSpanNormalizer(opts: { databaseSystem?: string } = {}) {
  const fallbackSystem = opts.databaseSystem ?? PRISMA_DEFAULT_DATABASE_SYSTEM
  return function normalizePrismaQuerySpan(span: SpanJSON): SpanJSON {
    const data = span.data ?? {}
    const rawQueryText = typeof data['db.query.text'] === 'string' ? data['db.query.text'] : undefined
    const hasPrismaDescription = span.description?.startsWith('prisma:') ?? false
    const isPrismaSpan
      = hasPrismaDescription
        || span.origin === 'auto.db.otel.prisma'
        || data['sentry.origin'] === 'auto.db.otel.prisma'
        || data['db.system'] === 'prisma'
        || data['db.system.name'] === 'prisma'

    if (!rawQueryText || !isPrismaSpan) {
      return span
    }

    const queryText = sanitizePrismaQueryText(rawQueryText)

    if (!queryText) {
      return span
    }

    let dbSystem = fallbackSystem

    if (typeof data['db.system.name'] === 'string' && data['db.system.name'] !== 'prisma') {
      dbSystem = data['db.system.name']
    }
    else if (typeof data['db.system'] === 'string' && data['db.system'] !== 'prisma') {
      dbSystem = data['db.system']
    }

    return {
      ...span,
      description: queryText,
      op: span.op ?? 'db',
      origin: span.origin ?? 'auto.db.otel.prisma',
      data: {
        ...data,
        'db.query.text': queryText,
        'db.system': dbSystem,
        'db.system.name': dbSystem,
        'sentry.op': typeof data['sentry.op'] === 'string' ? data['sentry.op'] : 'db',
        'sentry.origin': typeof data['sentry.origin'] === 'string' ? data['sentry.origin'] : 'auto.db.otel.prisma',
      },
    }
  }
}
