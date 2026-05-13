import * as Sentry from "@sentry/bun";
import { buildSentryReport } from "./sentry-report.js";
function getStatusCode(error) {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const value = error.statusCode;
    if (typeof value === "number") {
      return value;
    }
  }
  return void 0;
}
export function captureNitroError(error, context, options) {
  const statusCode = getStatusCode(error);
  if (statusCode !== void 0 && statusCode >= 400 && statusCode < 500) {
    return;
  }
  const { filter, enricher } = options ?? {};
  if (filter !== void 0 && !filter(error)) {
    return;
  }
  const errorLike = typeof error === "object" && error !== null ? error : {};
  const baseReport = buildSentryReport(errorLike, context.event);
  const { event } = context;
  if (event?.path !== void 0) {
    baseReport.extra.url = event.path;
  }
  if (event?.method !== void 0) {
    baseReport.extra.method = event.method;
  }
  const enrichment = enricher?.(error, context.event) ?? {};
  const extras = { ...baseReport.extra, ...enrichment.extra };
  const tags = { ...baseReport.tags, ...enrichment.tags };
  const tagKeys = Object.keys(tags);
  Sentry.withScope((scope) => {
    scope.setExtras(extras);
    if (tagKeys.length > 0) {
      scope.setTags(tags);
    }
    Sentry.captureException(error, {
      mechanism: { handled: false, type: "nitro" }
    });
  });
}
