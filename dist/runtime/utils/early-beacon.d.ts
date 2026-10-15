export declare const EARLY_BEACON_HEAD_KEY = "nuxt-sentry-early-beacon";
export declare const EARLY_BEACON_SDK_NAME = "nuxt-sentry.early-beacon";
export interface EarlyBeaconOptions {
    dsn: string;
    tunnelEndpoint: string;
    release: string | undefined;
    excludeLocalhostInProd: boolean;
    version: string;
}
export declare function buildEarlyBeaconScript(options: EarlyBeaconOptions): string;
