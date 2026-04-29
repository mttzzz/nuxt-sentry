export declare const IGNORED_VIEW_TRANSITION_ERRORS: RegExp[];
export declare const IGNORED_MANIFEST_POLL_ERRORS: RegExp[];
export declare function buildIgnoreErrors(additional?: (string | RegExp)[]): (string | RegExp)[];
export declare function isIgnoredSentryMessage(message: string, additional?: (string | RegExp)[]): boolean;
