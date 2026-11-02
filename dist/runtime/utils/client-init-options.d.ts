import * as Sentry from '@sentry/vue';
type ClientInitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type RouterOption = NonNullable<Parameters<typeof Sentry.browserTracingIntegration>[0]>['router'];
export declare const CLIENT_IGNORE_SPANS: NonNullable<ClientInitOptions['ignoreSpans']>;
export interface ClientInitInput {
    app: ClientInitOptions['app'];
    router: RouterOption;
    dsn: string;
    release: string | undefined;
    tunnel: string;
    enabled: boolean;
    tracesSampleRate: number;
    replaysSessionSampleRate: number;
    replaysOnErrorSampleRate: number;
    ignoreErrors: (string | RegExp)[];
    beforeSend: ClientInitOptions['beforeSend'];
    tracePropagationTargets: (string | RegExp)[];
}
export declare function buildClientSentryOptions(input: ClientInitInput): ClientInitOptions;
export {};
