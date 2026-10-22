import { clip } from "./clip.js";
export const LOAD_TIMEOUT_EVENT = "app:load-timeout";
export const LOAD_TIMEOUT_FINGERPRINT = "app-load-timeout";
export const LOAD_TIMEOUT_LEVEL = "error";
export const LOAD_TIMEOUT_KINDS = ["chunk", "entry"];
export const LOAD_TIMEOUT_MESSAGE_PREFIX = "\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u043E\u0441\u044C \u0437\u0430 ";
export const LOAD_TIMEOUT_MESSAGE_SUFFIX = " \u0441";
export const LOAD_TIMEOUT_MESSAGE_GENERIC = "\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u043E\u0441\u044C";
const CONTEXT_TEXT_LIMIT = 2e3;
export function loadTimeoutSeconds(timeoutMs) {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return void 0;
  }
  return Math.round(timeoutMs / 1e3);
}
export function loadTimeoutMessage(timeoutMs) {
  const seconds = loadTimeoutSeconds(timeoutMs);
  return seconds === void 0 ? LOAD_TIMEOUT_MESSAGE_GENERIC : `${LOAD_TIMEOUT_MESSAGE_PREFIX}${seconds}${LOAD_TIMEOUT_MESSAGE_SUFFIX}`;
}
export function toLoadTimeoutEvent(detail) {
  const tags = {};
  const load = {};
  if (typeof detail.timeoutMs === "number" && Number.isFinite(detail.timeoutMs)) {
    tags["load.timeoutMs"] = String(detail.timeoutMs);
    load.timeoutMs = detail.timeoutMs;
  }
  if (typeof detail.elapsedMs === "number" && Number.isFinite(detail.elapsedMs)) {
    tags["load.elapsedMs"] = String(detail.elapsedMs);
    load.elapsedMs = detail.elapsedMs;
  }
  if (detail.kind !== void 0 && LOAD_TIMEOUT_KINDS.some((kind) => kind === detail.kind)) {
    tags["load.kind"] = detail.kind;
    load.kind = detail.kind;
  }
  if (typeof detail.url === "string" && detail.url !== "") {
    load.url = clip(detail.url, CONTEXT_TEXT_LIMIT);
  }
  return {
    message: loadTimeoutMessage(detail.timeoutMs),
    level: LOAD_TIMEOUT_LEVEL,
    fingerprint: [LOAD_TIMEOUT_FINGERPRINT],
    tags,
    contexts: { load }
  };
}
