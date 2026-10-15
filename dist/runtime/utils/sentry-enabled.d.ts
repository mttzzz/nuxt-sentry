export declare const LOCAL_HOSTS: ReadonlySet<string>;
export declare function shouldEnableServerSentry(env: {
    nodeEnv: string | undefined;
    sentryDisabled: string | undefined;
}): boolean;
export declare function shouldEnableClientSentry(opts: {
    isProd: boolean;
    hostname: string;
    excludeLocalhost: boolean;
}): boolean;
