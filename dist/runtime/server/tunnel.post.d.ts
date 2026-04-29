declare const _default: import("h3").EventHandler<import("h3").EventHandlerRequest, Promise<{
    error: string;
    status?: undefined;
    tunnelError?: undefined;
} | {
    status: number;
    error?: undefined;
    tunnelError?: undefined;
} | {
    status: number;
    tunnelError: boolean;
    error?: undefined;
} | null>>;
export default _default;
