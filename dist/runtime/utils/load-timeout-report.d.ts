import type { Event } from '@sentry/core';
export declare const LOAD_TIMEOUT_EVENT = "app:load-timeout";
export declare const LOAD_TIMEOUT_FINGERPRINT = "app-load-timeout";
export declare const LOAD_TIMEOUT_LEVEL = "error";
export declare const LOAD_TIMEOUT_KINDS: readonly ["chunk", "entry"];
export type LoadTimeoutKind = (typeof LOAD_TIMEOUT_KINDS)[number];
export declare const LOAD_TIMEOUT_STAGES: readonly ["network", "boot"];
export type LoadTimeoutStage = (typeof LOAD_TIMEOUT_STAGES)[number];
export declare const LOAD_TIMEOUT_HOST_UNKNOWN = "unknown";
export interface LoadTimeoutError {
    message: string;
    source?: string;
}
export interface LoadTimeoutDetail {
    reason: 'load-timeout';
    timeoutMs: number;
    elapsedMs: number;
    visibleMs?: number;
    hiddenMs?: number;
    url?: string;
    kind?: LoadTimeoutKind;
    stage?: LoadTimeoutStage;
    host?: string;
    readyState?: string;
    online?: boolean;
    pending?: string[];
    pendingCount?: number;
    criticalCount?: number;
    vueMounted?: boolean;
    errors?: LoadTimeoutError[];
}
export declare const LOAD_TIMEOUT_MESSAGE_PREFIX = "\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u043E\u0441\u044C \u0437\u0430 ";
export declare const LOAD_TIMEOUT_MESSAGE_SUFFIX = " \u0441";
export declare const LOAD_TIMEOUT_MESSAGE_GENERIC = "\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u043E\u0441\u044C";
export declare const LOAD_TIMEOUT_MESSAGE_NETWORK_PREFIX = ": \u043D\u0435 \u043F\u0440\u0438\u0448\u043B\u0438 \u0440\u0435\u0441\u0443\u0440\u0441\u044B (";
export declare const LOAD_TIMEOUT_MESSAGE_NETWORK_SUFFIX = ")";
export declare const LOAD_TIMEOUT_MESSAGE_BOOT = ": \u0441\u0431\u043E\u0439 \u043F\u0440\u0438 \u0441\u0442\u0430\u0440\u0442\u0435";
export declare function loadTimeoutSeconds(timeoutMs: unknown): number | undefined;
export declare function loadTimeoutMessage(timeoutMs: unknown): string;
export declare function toLoadTimeoutEvent(detail: LoadTimeoutDetail): Event;
