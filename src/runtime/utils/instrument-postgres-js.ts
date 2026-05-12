/*
 * Portable instrumentation для postgres-js (npm `postgres`).
 *
 * Зачем не `Sentry.postgresJsIntegration()`: OTEL-based интеграции Sentry'я
 * патчат модули через `import-in-the-middle` / `require-in-the-middle`. На Bun
 * import-in-the-middle сломан (см. https://github.com/getsentry/sentry-javascript/issues/14202)
 * — реальный wrap никогда не срабатывает, db-спанов нет. Плюс Nitro бандлит
 * `postgres` в один файл — даже на Node патчить нечего.
 *
 * Решение: `Sentry.instrumentPostgresJsSql` — официальная portable-обёртка
 * из `@sentry/core` (используется внутри cloudflare/deno SDK). Патчит уже
 * созданный sql-инстанс через JS Proxy, не зависит от модульных хуков.
 *
 * Применение (в `server/db/client.ts` консьюмера):
 *   import postgres from 'postgres'
 *   import { drizzle } from 'drizzle-orm/postgres-js'
 *   // instrumentPostgresJs auto-imported из @mttzzz/nuxt-sentry
 *   const client = instrumentPostgresJs(postgres(url, {...}))
 *   export const db = drizzle({ client, ... })
 *
 * Спаны (op=db) создаются только внутри активного parent-спана (HTTP-транзакция,
 * queue.process, cron). Запросы из migration-скриптов / standalone утилит
 * спанов не создают — это by design (`requireParentSpan: true`).
 *
 * Drizzle-совместимость:
 *   - `client.unsafe(sql, params, opts)` (все queries Drizzle) → перехвачено
 *   - `client.begin(cb)` (транзакции) → перехвачено, tx-client тоже оборачивается
 *   - `client.options.parsers/serializers` (мутация Drizzle на старте) → Proxy
 *     прозрачно отдаёт оригинальный объект, мутация попадает в исходный sql
 */

import { instrumentPostgresJsSql } from '@sentry/core'

export interface InstrumentPostgresJsOptions {
  /**
   * Если true — спан создаётся только при наличии активного parent-спана
   * (HTTP transaction / queue.process / cron). Default Sentry: true.
   * Менять обычно не нужно — false добавит шум вне веб-контекста.
   */
  requireParentSpan?: boolean
}

/**
 * Оборачивает postgres-js sql-инстанс Sentry-инструментацией. Возвращает Proxy
 * с тем же API — drop-in замена. Безопасно вызывать без инициализированного
 * Sentry: при отсутствии активного parent-спана спаны просто не создаются.
 *
 * Generic без constraint: postgres-js типизирует sql как `Sql<{}>` с большим
 * числом полей, мы не должны заужать. Главное — вернуть `T` чтобы typesinference
 * сохранился у консьюмера (drizzle, и т.п.).
 */
export function instrumentPostgresJs<T>(sql: T, options?: InstrumentPostgresJsOptions): T {
  return instrumentPostgresJsSql(sql as never, options) as T
}
