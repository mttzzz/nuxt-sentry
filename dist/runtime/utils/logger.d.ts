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
    withSourceScope: (tag: string, extra: Record<string, unknown>, write: () => void) => void;
    addBreadcrumb: (breadcrumb: SentryBreadcrumb) => void;
}
export declare function createLoggerWithSink(tag: string, sink: LoggerSink): Logger;
export declare function createLogger(tag: string): Logger;
