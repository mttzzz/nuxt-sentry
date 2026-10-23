import { clip } from "./clip.js";
export const LOAD_TIMEOUT_EVENT = "app:load-timeout";
export const LOAD_TIMEOUT_FINGERPRINT = "app-load-timeout";
export const LOAD_TIMEOUT_LEVEL = "error";
export const LOAD_TIMEOUT_KINDS = ["chunk", "entry"];
export const LOAD_TIMEOUT_STAGES = ["network", "boot"];
export const LOAD_TIMEOUT_HOST_UNKNOWN = "unknown";
export const LOAD_TIMEOUT_MESSAGE_PREFIX = "\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u043E\u0441\u044C \u0437\u0430 ";
export const LOAD_TIMEOUT_MESSAGE_SUFFIX = " \u0441";
export const LOAD_TIMEOUT_MESSAGE_GENERIC = "\u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u043E\u0441\u044C";
export const LOAD_TIMEOUT_MESSAGE_NETWORK_PREFIX = ": \u043D\u0435 \u043F\u0440\u0438\u0448\u043B\u0438 \u0440\u0435\u0441\u0443\u0440\u0441\u044B (";
export const LOAD_TIMEOUT_MESSAGE_NETWORK_SUFFIX = ")";
export const LOAD_TIMEOUT_MESSAGE_BOOT = ": \u0441\u0431\u043E\u0439 \u043F\u0440\u0438 \u0441\u0442\u0430\u0440\u0442\u0435";
const TAG_VALUE_LIMIT = 200;
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
function textOf(value) {
  return typeof value === "string" ? value : "";
}
function labelOf(text) {
  return clip(text.replaceAll(/\s+/gu, " "), TAG_VALUE_LIMIT).trim();
}
function addNumber(tags, load, key, value, tagged = true) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return;
  }
  load[key] = value;
  if (tagged) {
    tags[`load.${key}`] = String(value);
  }
}
function addFlag(tags, load, key, value) {
  if (typeof value !== "boolean") {
    return;
  }
  load[key] = value;
  tags[`load.${key}`] = String(value);
}
function textsOf(value) {
  if (!Array.isArray(value)) {
    return void 0;
  }
  const items = value;
  return items.filter((item) => typeof item === "string").map((item) => clip(item, CONTEXT_TEXT_LIMIT));
}
function errorsOf(value) {
  if (!Array.isArray(value)) {
    return void 0;
  }
  const entries = value;
  const errors = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("message" in entry) || typeof entry.message !== "string") {
      continue;
    }
    const error = { message: clip(entry.message, CONTEXT_TEXT_LIMIT) };
    if ("source" in entry && typeof entry.source === "string" && entry.source !== "") {
      error.source = clip(entry.source, CONTEXT_TEXT_LIMIT);
    }
    errors.push(error);
  }
  return errors;
}
export function toLoadTimeoutEvent(detail) {
  const fields = detail;
  const tags = {};
  const load = {};
  const stage = LOAD_TIMEOUT_STAGES.find((candidate) => candidate === fields.stage);
  const host = stage === "network" ? textOf(fields.host) : "";
  const hostLabel = labelOf(host);
  const readyState = textOf(fields.readyState);
  const readyStateLabel = labelOf(readyState);
  const url = textOf(fields.url);
  const pending = textsOf(fields.pending);
  const errors = errorsOf(fields.errors);
  const shownHost = hostLabel === "" ? LOAD_TIMEOUT_HOST_UNKNOWN : hostLabel;
  let message = loadTimeoutMessage(fields.timeoutMs);
  const fingerprint = [LOAD_TIMEOUT_FINGERPRINT];
  addNumber(tags, load, "timeoutMs", fields.timeoutMs);
  addNumber(tags, load, "visibleMs", fields.visibleMs);
  addNumber(tags, load, "hiddenMs", fields.hiddenMs);
  addNumber(tags, load, "elapsedMs", fields.elapsedMs);
  if (url !== "") {
    load.url = clip(url, CONTEXT_TEXT_LIMIT);
  }
  const kind = LOAD_TIMEOUT_KINDS.find((candidate) => candidate === fields.kind);
  if (kind !== void 0) {
    tags["load.kind"] = kind;
    load.kind = kind;
  }
  if (stage !== void 0) {
    tags["load.stage"] = stage;
    load.stage = stage;
    fingerprint.push(stage);
  }
  if (stage === "network") {
    message += `${LOAD_TIMEOUT_MESSAGE_NETWORK_PREFIX}${shownHost}${LOAD_TIMEOUT_MESSAGE_NETWORK_SUFFIX}`;
    fingerprint.push(shownHost);
  } else if (stage === "boot") {
    message += LOAD_TIMEOUT_MESSAGE_BOOT;
  }
  if (hostLabel !== "") {
    tags["load.host"] = hostLabel;
    load.host = clip(host, CONTEXT_TEXT_LIMIT);
  }
  if (readyStateLabel !== "") {
    tags["load.readyState"] = readyStateLabel;
    load.readyState = clip(readyState, CONTEXT_TEXT_LIMIT);
  }
  addFlag(tags, load, "online", fields.online);
  addFlag(tags, load, "vueMounted", fields.vueMounted);
  addNumber(tags, load, "pendingCount", fields.pendingCount);
  addNumber(tags, load, "criticalCount", fields.criticalCount, false);
  if (pending !== void 0) {
    load.pending = pending;
  }
  if (errors !== void 0) {
    load.errors = errors;
  }
  return {
    message,
    level: LOAD_TIMEOUT_LEVEL,
    fingerprint,
    tags,
    contexts: { load }
  };
}
