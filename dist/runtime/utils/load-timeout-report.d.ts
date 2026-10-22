import type { Event } from '@sentry/core';
export declare const LOAD_TIMEOUT_EVENT = "app:load-timeout";
export declare const LOAD_TIMEOUT_FINGERPRINT = "app-load-timeout";
export declare const LOAD_TIMEOUT_LEVEL = "error";
export declare const LOAD_TIMEOUT_KINDS: readonly ["chunk", "entry"];
export type LoadTimeoutKind = (typeof LOAD_TIMEOUT_KINDS)[number];
export interface LoadTimeoutDetail {
    reason: 'load-timeout';
    timeoutMs: number;
    elapsedMs: number;
    url?: string;
    kind?: LoadTimeoutKind;
}
export declare const LOAD_TIMEOUT_MESSAGE_PREFIX = "\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u043E\u0441\u044C \u0437\u0430 ";
export declare const LOAD_TIMEOUT_MESSAGE_SUFFIX = " \u0441";
export declare const LOAD_TIMEOUT_MESSAGE_GENERIC = "\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u043E\u0441\u044C";
export declare function loadTimeoutSeconds(timeoutMs: unknown): number | undefined;
export declare function loadTimeoutMessage(timeoutMs: unknown): string;
export declare function toLoadTimeoutEvent(detail: LoadTimeoutDetail): Event;
