function isRecord(value) {
  return typeof value === "object" && value !== null;
}
export function buildSentryReport(error, event) {
  const url = event?.node?.req?.url ?? "Unknown URL";
  const method = event?.node?.req?.method ?? "Unknown Method";
  const headers = event?.node?.req?.headers ? JSON.stringify(event.node.req.headers) : "No headers";
  const extra = { url, method, headers };
  if (isRecord(error.data)) {
    extra.appData = error.data;
  }
  if (error.cause !== void 0 && error.cause !== null) {
    extra.cause = summarizeCause(error.cause);
  }
  return {
    extra,
    tags: { source: "nitro-error-hook" }
  };
}
function summarizeCause(cause) {
  if (!isRecord(cause)) {
    return typeof cause === "string" ? cause : String(cause);
  }
  const summary = {};
  if (typeof cause.name === "string") {
    summary.name = cause.name;
  }
  if (typeof cause.message === "string") {
    summary.message = cause.message;
  }
  if (isRecord(cause.$metadata) && typeof cause.$metadata.httpStatusCode === "number") {
    summary.httpStatusCode = cause.$metadata.httpStatusCode;
  }
  if (typeof cause.stack === "string") {
    summary.stack = cause.stack;
  }
  return summary;
}
