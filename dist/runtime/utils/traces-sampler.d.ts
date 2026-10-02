export interface TracesSamplerOptions {
    /** Доля транзакций для всего, что не попало под правила 1–3. */
    tracesSampleRate: number;
    /** Доля для корней `queue.publish/…` и `queue.process/…`. */
    queueTracesSampleRate: number;
    /** Префиксы пути запроса, которые не трассируем (`startsWith`, не граница сегмента). */
    ignoredRoutes: readonly string[];
}
export interface TracesSamplingContext {
    name?: string;
    attributes?: Readonly<Record<string, unknown>>;
}
export declare function createTracesSampler(options: TracesSamplerOptions): (context: TracesSamplingContext) => number;
