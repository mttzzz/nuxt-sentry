import { defineEventHandler, readRawBody, setResponseStatus } from "h3";
import { useRuntimeConfig } from "nitropack/runtime";
import { tunnelIngestUrl } from "#nuxt-sentry/config";
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event);
  if (config.testMode || process.env.SENTRY_DISABLED === "1") {
    setResponseStatus(event, 204);
    return null;
  }
  const rawBody = await readRawBody(event, false);
  if (!rawBody) {
    setResponseStatus(event, 400);
    return { error: "Empty request body" };
  }
  try {
    const response = await fetch(tunnelIngestUrl, {
      body: rawBody,
      headers: {
        "Content-Type": "application/x-sentry-envelope"
      },
      method: "POST"
    });
    return { status: response.status };
  } catch {
    return { status: 200, tunnelError: true };
  }
});
