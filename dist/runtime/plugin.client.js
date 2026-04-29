import { replayIntegration } from "@sentry/browser";
import * as Sentry from "@sentry/vue";
import { defineNuxtPlugin, useRouter, useRuntimeConfig } from "#app";
import { additionalIgnorePatterns, tracePropagationTargets } from "#nuxt-sentry/config";
import { buildIgnoreErrors } from "./utils/ignore-errors.js";
import { shouldEnableClientSentry } from "./utils/sentry-enabled.js";
export default defineNuxtPlugin(async (nuxtApp) => {
  const { createSentryStaleChunkFilter } = await import("@mttzzz/nuxt-stale-deploy-guard/sentry");
  const config = useRuntimeConfig().public.sentry;
  const router = useRouter();
  Sentry.init({
    app: nuxtApp.vueApp,
    dsn: config.dsn,
    tunnel: config.tunnelEndpoint,
    enabled: shouldEnableClientSentry({
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
    ignoreErrors: buildIgnoreErrors(additionalIgnorePatterns),
    beforeSend: createSentryStaleChunkFilter(),
    tracePropagationTargets,
    ignoreSpans: [
      { op: /^browser\.(cache|connect|DNS)$/ },
      { op: "resource.other", name: /.+\.(woff2|woff|ttf|eot)$/ },
      { op: "resource.link", name: /.+\.css.*$/ },
      { op: /resource\.(link|script)/, name: /.+\.js.*$/ },
      { op: /resource\.(other|img)/, name: /.+\.(png|svg|jpeg|jpg|gif|bmp|tif|tiff|webp|avif|heic|heif|ico).*$/ },
      { op: "measure" }
    ],
    debug: false,
    integrations: [
      Sentry.browserTracingIntegration({ router }),
      Sentry.vueIntegration({ app: nuxtApp.vueApp, attachErrorHandler: false }),
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
