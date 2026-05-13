import { defineNitroPlugin } from "nitropack/runtime";
import errorReportEnricher from "#nuxt-sentry/error-enricher";
import errorReportFilter from "#nuxt-sentry/error-filter";
import { captureNitroError } from "../utils/capture-nitro-error.js";
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("error", (error, ctx) => {
    captureNitroError(error, ctx, { filter: errorReportFilter, enricher: errorReportEnricher });
  });
});
