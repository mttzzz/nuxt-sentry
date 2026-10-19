import { isChunkReloadBlockedEvent } from "./chunk-reload-report.js";
const EXTENSION_PROTOCOL = /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//u;
const URL_SEARCH_OR_HASH = /[?#].*$/su;
function isNoiseFrame(filename, documentUrl) {
  return filename === void 0 || filename === "" || filename === "<anonymous>" || filename === "undefined" || filename === "[native code]" || EXTENSION_PROTOCOL.test(filename) || documentUrl !== void 0 && filename.replace(URL_SEARCH_OR_HASH, "") === documentUrl;
}
const STACKLESS_INJECTED_ERRORS = { "Error: La": true };
export function isNoiseEvent(event) {
  const values = event.exception?.values ?? [];
  const frames = values.flatMap((value) => value.stacktrace?.frames ?? []);
  if (frames.length === 0) {
    return values.length > 0 && values.every((value) => STACKLESS_INJECTED_ERRORS[`${value.type}: ${value.value}`] === true);
  }
  const documentUrl = event.request?.url?.replace(URL_SEARCH_OR_HASH, "");
  return frames.every((frame) => isNoiseFrame(frame.filename, documentUrl));
}
const CONSOLE_MECHANISM = "auto.core.capture_console";
function isConsoleEvent(event) {
  return event.logger === "console" || event.exception?.values?.some((value) => value.mechanism?.type === CONSOLE_MECHANISM) === true;
}
const NON_APP_FRAME_FUNCTIONS = {
  output: true,
  withSourceScope: true,
  warn: true,
  error: true,
  info: true,
  debug: true,
  "": true,
  "<anonymous>": true,
  "?": true
};
const LOGGER_METHODS = { warn: true, error: true, info: true, debug: true };
function demoteSinkFrames(frames) {
  if (!frames) {
    return;
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (!frame) {
      return;
    }
    if (frame.in_app !== false && NON_APP_FRAME_FUNCTIONS[frame.function ?? ""] !== true) {
      return;
    }
    frame.in_app = false;
    if (LOGGER_METHODS[frame.function ?? ""] === true) {
      return;
    }
  }
}
export function normalizeConsoleEvent(event) {
  if (!isConsoleEvent(event)) {
    return event;
  }
  const level = event.level ?? "log";
  const type = level === "warning" ? "console.warn" : `console.${level}`;
  for (const value of event.exception?.values ?? []) {
    if (value.type) {
      continue;
    }
    value.type = type;
    if (value.mechanism?.synthetic) {
      value.mechanism.synthetic = false;
    }
    demoteSinkFrames(value.stacktrace?.frames);
  }
  return event;
}
export function normalizeMessageEvent(event) {
  const values = event.exception?.values;
  if (values?.length !== 1 || isConsoleEvent(event) || event.message === void 0 && event.logentry === void 0) {
    return event;
  }
  const [value] = values;
  if (value === void 0 || value.type !== void 0 || value.mechanism?.synthetic !== true) {
    return event;
  }
  if (value.stacktrace?.frames?.length) {
    event.threads = { values: [{ stacktrace: value.stacktrace, crashed: false, current: true }] };
  }
  delete event.exception;
  return event;
}
export function createClientBeforeSend(staleChunkFilter) {
  return (event) => {
    if (isNoiseEvent(event)) {
      return null;
    }
    const normalized = normalizeMessageEvent(normalizeConsoleEvent(event));
    return isChunkReloadBlockedEvent(normalized) ? normalized : staleChunkFilter(normalized);
  };
}
