import * as Sentry from "@sentry/vue";
import { DATA_COLLECTION } from "./data-collection.js";
export const CLIENT_IGNORE_SPANS = [
  { op: /^browser\.(?:cache|connect|dns)$/iu },
  { op: "resource.other", attributes: { "url.full": /\.(?:woff2|woff|ttf|eot)(?:[?#].*)?$/u } },
  { op: "resource.link", attributes: { "url.full": /\.css(?:[?#].*)?$/u } },
  { op: /resource\.(?:link|script)/u, attributes: { "url.full": /\.js(?:[?#].*)?$/u } },
  {
    op: /resource\.(?:other|img)/u,
    attributes: { "url.full": /\.(?:png|svg|jpeg|jpg|gif|bmp|tif|tiff|webp|avif|heic|heif|ico)(?:[?#].*)?$/u }
  },
  { op: "measure" }
];
export function buildClientSentryOptions(input) {
  return {
    app: input.app,
    dsn: input.dsn,
    release: input.release,
    tunnel: input.tunnel,
    enabled: input.enabled,
    tracesSampleRate: input.tracesSampleRate,
    replaysSessionSampleRate: input.replaysSessionSampleRate,
    replaysOnErrorSampleRate: input.replaysOnErrorSampleRate,
    dataCollection: DATA_COLLECTION,
    attachStacktrace: true,
    normalizeDepth: 8,
    maxValueLength: 2e3,
    ignoreErrors: input.ignoreErrors,
    beforeSend: input.beforeSend,
    tracePropagationTargets: input.tracePropagationTargets,
    ignoreSpans: CLIENT_IGNORE_SPANS,
    enhanceFetchErrorMessages: "report-only",
    debug: false,
    integrations: [
      Sentry.browserTracingIntegration({ router: input.router }),
      Sentry.vueIntegration({ app: input.app, attachErrorHandler: false }),
      Sentry.captureConsoleIntegration({ levels: ["warn", "error"] }),
      Sentry.browserSessionIntegration({ lifecycle: "route" })
    ]
  };
}
