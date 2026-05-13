export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}
export interface SentryBreadcrumb {
    category: string;
    message: string;
    level: 'info' | 'warning';
    data?: Record<string, unknown>;
}
export interface LoggerSink {
    isProduction: boolean;
    output: (level: LogLevel, tag: string, message: string, args: unknown[]) => void;
    captureException: (error: unknown, ctx: {
        tags: Record<string, string>;
        extra: Record<string, unknown>;
    }) => void;
    captureMessage: (message: string, ctx: {
        level: 'error';
        tags: Record<string, string>;
        extra: Record<string, unknown>;
    }) => void;
    addBreadcrumb: (breadcrumb: SentryBreadcrumb) => void;
}
export declare function createLoggerWithSink(tag: string, sink: LoggerSink): Logger;
export declare function createLogger(tag: string): Logger;
