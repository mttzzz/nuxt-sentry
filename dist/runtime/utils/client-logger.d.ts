export interface ClientLogger {
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
}
export declare function createLogger(tag: string): ClientLogger;
