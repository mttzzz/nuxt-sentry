import { type Logger } from './logger.js';
export interface SentryTaskMeta {
    name: string;
    description: string;
    cron?: string;
}
export interface SentryTaskOutcome {
    result: 'success' | 'error';
    message?: string;
    [key: string]: unknown;
}
interface SentryRuntime {
    startNewTrace: (fn: () => Promise<unknown>) => Promise<unknown>;
    startSpan: (opts: {
        op: string;
        name: string;
        attributes?: Record<string, unknown>;
    }, fn: () => Promise<unknown>) => Promise<unknown>;
    withMonitor: (slug: string, fn: () => Promise<unknown>, monitorConfig: unknown) => Promise<unknown>;
}
interface LoggerSurface {
    error: (msg: string, ...args: unknown[]) => void;
}
interface RunBodyArgs<R extends Record<string, unknown>> {
    meta: {
        name: string;
        cron?: string;
    };
    run: () => Promise<R>;
    logger: LoggerSurface;
    sentry: SentryRuntime;
}
export declare function runSentryTaskBody<R extends Record<string, unknown>>({ meta, run, logger, sentry, }: RunBodyArgs<R>): Promise<SentryTaskOutcome>;
export declare function defineSentryTask<R extends Record<string, unknown>>(opts: {
    meta: SentryTaskMeta;
    run: (ctx: {
        logger: Logger;
    }) => Promise<R>;
}): import("nitropack/types").Task<"error" | "success">;
export {};
