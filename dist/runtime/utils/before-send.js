const EXTENSION_PROTOCOL = /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//u;
function isNoiseFrame(filename = "") {
  return filename === "" || filename === "<anonymous>" || EXTENSION_PROTOCOL.test(filename);
}
export function isNoiseEvent(event) {
  const frames = event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];
  if (frames.length === 0) {
    return false;
  }
  return frames.every((frame) => isNoiseFrame(frame.filename));
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
