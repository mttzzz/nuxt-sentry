import * as Sentry from "@sentry/bun";
function getStatusCode(error) {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const value = error.statusCode;
    if (typeof value === "number") return value;
  }
  return void 0;
}
export function captureNitroError(error, context) {
  const statusCode = getStatusCode(error);
  if (statusCode !== void 0 && statusCode >= 400 && statusCode < 500) {
    return;
  }
  Sentry.withScope((scope) => {
    scope.setExtras({
      url: context.event?.path,
      method: context.event?.method
    });
    Sentry.captureException(error, {
      mechanism: { handled: false, type: "nitro" }
    });
  });
}
