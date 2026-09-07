interface NitroErrorContext {
    event?: {
        path?: string;
        method?: string;
        node?: {
            req?: {
                url?: string;
                method?: string;
                headers?: Record<string, string | string[] | undefined>;
            };
        };
    };
}
export interface CaptureNitroErrorOptions {
    filter?: (error: unknown) => boolean;
    enricher?: (error: unknown, event?: unknown) => {
        extra?: Record<string, unknown>;
        tags?: Record<string, string>;
    };
}
export declare function captureNitroError(error: unknown, context: NitroErrorContext, options?: CaptureNitroErrorOptions): void;
export {};
