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
  }
}
export function normalizeConsoleEvent(event) {
  const isConsole = event.logger === "console" || event.exception?.values?.some((value) => value.mechanism?.type === CONSOLE_MECHANISM) === true;
  if (!isConsole) {
    return event;
  }
  const level = event.level ?? "log";
  const type = level === "warning" ? "console.warn" : `console.${level}`;
  for (const value of event.exception?.values ?? []) {
    if (value.type) {
      continue;
    }
    value.type = type;
    demoteSinkFrames(value.stacktrace?.frames);
  }
  return event;
}
