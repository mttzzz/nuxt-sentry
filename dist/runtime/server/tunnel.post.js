import { defineEventHandler, getRequestIP, readRawBody, setResponseStatus } from "h3";
import { useRuntimeConfig } from "nitropack/runtime";
import { tunnelIngestUrl } from "#nuxt-sentry/config";
import { enrichEnvelope } from "../utils/enrich-envelope.js";
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
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? "";
  const ctxUser = event.context.user;
  const body = enrichEnvelope(rawBody, {
    ip,
    user: {
      id: ctxUser?.id,
      email: ctxUser?.email,
      username: ctxUser?.name ?? void 0
    }
  });
  try {
    const response = await fetch(tunnelIngestUrl, {
      /* Buffer типизирован над ArrayBufferLike, BodyInit ждёт ArrayBufferView<ArrayBuffer>;
         Buffer из readRawBody/Buffer.concat всегда лежит на ArrayBuffer, не на SharedArrayBuffer. */
      body,
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
