export declare function routePatternToRegExpSource(pattern: string): string;
export declare function createRouteMatcher(patterns: readonly string[]): (pathname: string) => boolean;
