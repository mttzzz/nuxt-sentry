export interface InstrumentPostgresJsOptions {
    /**
     * Если true — спан создаётся только при наличии активного parent-спана
     * (HTTP transaction / queue.process / cron). Default Sentry: true.
     * Менять обычно не нужно — false добавит шум вне веб-контекста.
     */
    requireParentSpan?: boolean;
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
export declare function instrumentPostgresJs<T>(sql: T, options?: InstrumentPostgresJsOptions): T;
