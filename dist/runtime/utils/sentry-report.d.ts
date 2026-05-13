import type { H3Event } from 'h3';
interface NitroErrorLike {
    cause?: unknown;
    data?: unknown;
    message?: string;
    statusCode?: number;
}
export interface SentryReport {
    extra: Record<string, unknown>;
    tags: Record<string, string>;
}
export declare function buildSentryReport(error: NitroErrorLike, event?: H3Event): SentryReport;
export {};
