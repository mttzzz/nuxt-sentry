import type { BunOptions } from '@sentry/bun';
import type { Integration } from '@sentry/core';
export interface ServerInitInput {
    dsn: string;
    release: string | undefined;
    enabled: boolean;
    cachePrefix: string;
    tracesSampleRate: number;
    queueTracesSampleRate: number;
    ignoredRoutes: readonly string[];
}
export declare function canSampleTraces(input: Pick<ServerInitInput, 'tracesSampleRate' | 'queueTracesSampleRate'>): boolean;
export declare function buildServerIntegrations(defaults: Integration[], cachePrefix: string, tracing: boolean): Integration[];
export type ServerSentryOptions = BunOptions & {
    enableRuntimeChannelInjection: boolean;
};
export declare function buildServerSentryOptions(input: ServerInitInput): ServerSentryOptions;
