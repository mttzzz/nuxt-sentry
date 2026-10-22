import { clip } from "./clip.js";
export const CHUNK_RELOAD_BLOCKED_EVENT = "app:chunk-reload-blocked";
export const CHUNK_REASON_TAG = "chunk.reason";
export const RETRY_FAILED_KINDS = ["chunk", "entry"];
const TITLES = {
  "unsupported-browser": "\u0411\u0440\u0430\u0443\u0437\u0435\u0440 \u0431\u0435\u0437 import maps",
  "not-stale": "\u0427\u0430\u043D\u043A \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0441\u044F, \u0431\u0438\u043B\u0434 \u0430\u043A\u0442\u0443\u0430\u043B\u0435\u043D",
  "circuit-breaker": "\u0427\u0430\u043D\u043A \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0441\u044F, \u043F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0438\u0441\u0447\u0435\u0440\u043F\u0430\u043D\u044B",
  cooldown: "\u0427\u0430\u043D\u043A \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0441\u044F \u0441\u0440\u0430\u0437\u0443 \u043F\u043E\u0441\u043B\u0435 \u043F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438",
  "no-build-id": "\u0427\u0430\u043D\u043A \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0441\u044F, build-id \u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u0435\u043D",
  "retry-failed": "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0430\u0441\u044C \u0438 \u043F\u043E\u0441\u043B\u0435 \u043F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438"
};
const REASONS = Object.keys(TITLES);
const TAG_VALUE_LIMIT = 200;
const CONTEXT_TEXT_LIMIT = 2e3;
export function isChunkReloadBlockedDetail(value) {
  if (typeof value !== "object" || value === null || !("reason" in value) || typeof value.reason !== "string" || !REASONS.includes(value.reason)) {
    return false;
  }
  return value.reason !== "retry-failed" || "kind" in value && RETRY_FAILED_KINDS.some((kind) => kind === value.kind);
}
function stringifyUnknown(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    const json = JSON.stringify(value);
    if (json !== void 0) {
      return json;
    }
  } catch {
  }
  return String(value);
}
function summarizeError(error) {
  if (error === void 0 || error === null) {
    return void 0;
  }
  try {
    if (typeof error !== "object") {
      return { message: clip(stringifyUnknown(error), CONTEXT_TEXT_LIMIT) };
    }
    const name = "name" in error ? error.name : void 0;
    const message = "message" in error ? error.message : void 0;
    const stack = "stack" in error ? error.stack : void 0;
    const summary = {
      message: clip(typeof message === "string" ? message : stringifyUnknown(error), CONTEXT_TEXT_LIMIT)
    };
    if (typeof name === "string" && name !== "") {
      summary.name = name;
    }
    if (typeof stack === "string" && stack !== "") {
      summary.stack = clip(stack, CONTEXT_TEXT_LIMIT);
    }
    return summary;
  } catch {
    return void 0;
  }
}
export function toChunkReloadBlockedEvent(detail) {
  const fields = detail;
  const tags = { [CHUNK_REASON_TAG]: detail.reason };
  const chunk = { reason: detail.reason };
  const fingerprint = ["chunk-reload-blocked", detail.reason];
  if (detail.reason === "retry-failed") {
    tags["chunk.kind"] = detail.kind;
    chunk.kind = detail.kind;
    fingerprint.push(detail.kind);
  }
  const error = summarizeError(fields.error);
  if (error !== void 0) {
    chunk.error = error;
    const text = clip(error.message.replaceAll(/\s+/gu, " ").trim(), TAG_VALUE_LIMIT);
    if (text !== "") {
      tags["chunk.error"] = text;
    }
  }
  if (typeof fields.missing === "string" && fields.missing !== "") {
    tags["chunk.missing"] = fields.missing;
  }
  if (Array.isArray(fields.probes)) {
    chunk.probes = fields.probes.filter((probe) => typeof probe === "string");
  }
  if (typeof fields.buildId === "string") {
    chunk.buildId = fields.buildId;
  }
  if (typeof fields.attempts === "number" && Number.isFinite(fields.attempts)) {
    chunk.attempts = fields.attempts;
  }
  if (typeof fields.windowMs === "number" && Number.isFinite(fields.windowMs)) {
    chunk.windowMs = fields.windowMs;
  }
  if (typeof fields.url === "string" && fields.url !== "") {
    chunk.url = clip(fields.url, CONTEXT_TEXT_LIMIT);
  }
  return {
    message: TITLES[detail.reason],
    level: detail.reason === "unsupported-browser" ? "warning" : "error",
    fingerprint,
    tags,
    contexts: { chunk }
  };
}
export function isChunkReloadBlockedEvent(event) {
  return event.tags?.[CHUNK_REASON_TAG] !== void 0;
}
export function createChunkReloadBlockedReporter(capture) {
  const reported = /* @__PURE__ */ new Set();
  return (detail) => {
    if (!isChunkReloadBlockedDetail(detail) || detail.reason === "retry-failed" || reported.has(detail.reason)) {
      return;
    }
    reported.add(detail.reason);
    capture(toChunkReloadBlockedEvent(detail));
  };
}
export function listenChunkReloadBlocked(capture, target = globalThis) {
  const report = createChunkReloadBlockedReporter(capture);
  function handler(event) {
    report(event.detail);
  }
  target.addEventListener(CHUNK_RELOAD_BLOCKED_EVENT, handler);
  return () => {
    target.removeEventListener(CHUNK_RELOAD_BLOCKED_EVENT, handler);
  };
}
