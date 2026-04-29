interface NitroErrorContext {
    event?: {
        path?: string;
        method?: string;
    };
}
export declare function captureNitroError(error: unknown, context: NitroErrorContext): void;
export {};
