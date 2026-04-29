import type { SpanJSON } from '@sentry/core';
export declare function sanitizePrismaQueryText(queryText: string): string;
export declare function createPrismaSpanNormalizer(opts?: {
    databaseSystem?: string;
}): (span: SpanJSON) => SpanJSON;
