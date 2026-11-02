export declare const FILTERED_VALUE = "[Filtered]";
export type HeaderValue = string | string[] | undefined;
export declare function isSensitiveHeaderName(name: string): boolean;
export declare function redactHeaders(headers: Readonly<Record<string, HeaderValue>>): Record<string, HeaderValue>;
