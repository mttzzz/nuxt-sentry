import * as Sentry from "@sentry/vue";
import { defineNuxtPlugin, useRouter, useRuntimeConfig } from "#app";
import { additionalIgnorePatterns, disabledRoutes, tracePropagationTargets } from "#nuxt-sentry/config";
import { loadSessionReplay } from "#nuxt-sentry/replay";
import { createClientBeforeSend } from "./utils/before-send.js";
import { listenChunkReloadBlocked } from "./utils/chunk-reload-report.js";
import { buildClientSentryOptions } from "./utils/client-init-options.js";
import { buildIgnoreErrors } from "./utils/ignore-errors.js";
import { createRouteMatcher } from "./utils/route-patterns.js";
import { shouldEnableClientSentry } from "./utils/sentry-enabled.js";
export default defineNuxtPlugin(async (nuxtApp) => {
  if (createRouteMatcher(disabledRoutes)(globalThis.location.pathname)) {
    return;
  }
  const { createSentryStaleChunkFilter } = await import("@mttzzz/nuxt-stale-deploy-guard/sentry");
  const config = useRuntimeConfig().public.sentry;
  const router = useRouter();
  const extraIgnore = additionalIgnorePatterns;
  const staleChunkFilter = createSentryStaleChunkFilter();
  Error.stackTraceLimit = 50;
  Sentry.init(
    buildClientSentryOptions({
      app: nuxtApp.vueApp,
      router,
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
      replaysOnErrorSampleRate: config.replaysOnErrorSampleRate ?? 1,
      ignoreErrors: buildIgnoreErrors(extraIgnore),
      beforeSend: createClientBeforeSend(staleChunkFilter),
      tracePropagationTargets
    })
  );
  void loadSessionReplay();
  listenChunkReloadBlocked((event) => {
    Sentry.captureEvent(event);
  });
  nuxtApp.hook("app:error", (error) => {
    Sentry.captureException(error);
  });
  nuxtApp.hook("vue:error", (error) => {
    Sentry.captureException(error);
  });
});
