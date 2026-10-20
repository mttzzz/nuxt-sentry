import type { Event } from '@sentry/core';
export declare const CHUNK_RELOAD_BLOCKED_EVENT = "app:chunk-reload-blocked";
export declare const CHUNK_REASON_TAG = "chunk.reason";
export interface UnsupportedBrowserDetail {
    reason: 'unsupported-browser';
    missing: string;
}
export interface NotStaleDetail {
    reason: 'not-stale';
    error?: unknown;
    probes: string[];
    buildId: string;
}
export interface CircuitBreakerDetail {
    reason: 'circuit-breaker';
    error?: unknown;
    probes: string[];
    buildId: string;
    attempts: number;
    windowMs: number;
}
export interface CooldownDetail {
    reason: 'cooldown';
    error?: unknown;
    buildId: string;
}
export interface NoBuildIdDetail {
    reason: 'no-build-id';
    error?: unknown;
}
export declare const RETRY_FAILED_KINDS: readonly ["chunk", "entry"];
export type RetryFailedKind = (typeof RETRY_FAILED_KINDS)[number];
export interface RetryFailedDetail {
    reason: 'retry-failed';
    kind: RetryFailedKind;
    error?: unknown;
    url?: string;
}
export type ChunkReloadBlockedDetail = UnsupportedBrowserDetail | NotStaleDetail | CircuitBreakerDetail | CooldownDetail | NoBuildIdDetail | RetryFailedDetail;
export type ChunkReloadBlockedReason = ChunkReloadBlockedDetail['reason'];
export declare function isChunkReloadBlockedDetail(value: unknown): value is ChunkReloadBlockedDetail;
export declare function toChunkReloadBlockedEvent(detail: ChunkReloadBlockedDetail): Event;
export declare function isChunkReloadBlockedEvent(event: Event): boolean;
export declare function createChunkReloadBlockedReporter(capture: (event: Event) => void): (detail: unknown) => void;
