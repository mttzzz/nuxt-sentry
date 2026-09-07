import type { Event } from '@sentry/core';
export declare function isNoiseEvent(event: Event): boolean;
export declare function normalizeConsoleEvent<T extends Event>(event: T): T;
export declare function normalizeMessageEvent<T extends Event>(event: T): T;
