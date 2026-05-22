import { replayIntegration } from "@sentry/browser";
import * as Sentry from "@sentry/vue";
import { defineNuxtPlugin, useRouter, useRuntimeConfig } from "#app";
import { additionalIgnorePatterns, tracePropagationTargets } from "#nuxt-sentry/config";
import { buildIgnoreErrors, isIgnoredSentryMessage } from "./utils/ignore-errors.js";
import { shouldEnableClientSentry } from "./utils/sentry-enabled.js";
export default defineNuxtPlugin(async (nuxtApp) => {
  const { createSentryStaleChunkFilter } = await import("@mttzzz/nuxt-stale-deploy-guard/sentry");
  const config = useRuntimeConfig().public.sentry;
  const router = useRouter();
  const extraIgnore = additionalIgnorePatterns;
  Sentry.init({
    app: nuxtApp.vueApp,
    dsn: config.dsn,
    release: config.release,
    tunnel: config.tunnelEndpoint,
    enabled: shouldEnableClientSentry({
      // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- import.meta.env is virtual module, typed as error but safe at runtime
      isProd: import.meta.env.PROD,
      hostname: globalThis.location.hostname,
      excludeLocalhost: config.excludeLocalhostInProd
    }),
    tracesSampleRate: config.tracesSampleRate,
    replaysSessionSampleRate: config.replaysSessionSampleRate,
    replaysOnErrorSampleRate: config.replaysOnErrorSampleRate,
    enableLogs: true,
    sendDefaultPii: true,
    attachStacktrace: true,
    normalizeDepth: 8,
    maxValueLength: 2e3,
    ignoreErrors: buildIgnoreErrors(extraIgnore),
    beforeSend: createSentryStaleChunkFilter(),
    beforeSendLog: (log) => {
      const body = log.message?.toString() ?? "";
      if (isIgnoredSentryMessage(body, extraIgnore)) {
        return null;
      }
      return log;
    },
    tracePropagationTargets,
    ignoreSpans: [
      { op: /^browser\.(cache|connect|DNS)$/u },
      { op: "resource.other", name: /.+\.(woff2|woff|ttf|eot)$/u },
      { op: "resource.link", name: /.+\.css.*$/u },
      { op: /resource\.(link|script)/u, name: /.+\.js.*$/u },
      { op: /resource\.(other|img)/u, name: /.+\.(png|svg|jpeg|jpg|gif|bmp|tif|tiff|webp|avif|heic|heif|ico).*$/u },
      { op: "measure" }
    ],
    debug: false,
    integrations: [
      Sentry.browserTracingIntegration({ router }),
      Sentry.vueIntegration({ app: nuxtApp.vueApp, attachErrorHandler: false }),
      // oxlint-disable-next-line typescript/no-unsafe-call -- replayIntegration from @sentry/browser is safe, typed as error due to module resolution
      replayIntegration({
        blockAllMedia: false,
        maskAllInputs: false,
        maskAllText: false,
        networkDetailAllowUrls: [globalThis.location.origin]
      }),
      Sentry.consoleLoggingIntegration({ levels: ["warn", "error", "info"] })
    ]
  });
  nuxtApp.hook("app:error", (error) => {
    Sentry.captureException(error);
  });
  nuxtApp.hook("vue:error", (error) => {
    Sentry.captureException(error);
  });
});
