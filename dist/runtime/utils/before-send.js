const EXTENSION_PROTOCOL = /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//u;
function isNoiseFrame(filename = "") {
  return filename === "" || filename === "<anonymous>" || EXTENSION_PROTOCOL.test(filename);
}
const STACK_LOCATION = /(?:\(|@|\bat\s+)([a-z][a-z-]*:\/\/[^\s()]+)/giu;
function isExtensionSerializedStack(rejection) {
  if (typeof rejection.stack !== "string") {
    return false;
  }
  const urls = [...rejection.stack.matchAll(STACK_LOCATION)].map((match) => match[1] ?? "");
  return urls.length > 0 && urls.every((url) => EXTENSION_PROTOCOL.test(url));
}
const EIP1193_CODES = { 4001: true, 4100: true, 4200: true, 4900: true, 4901: true };
function isWalletProviderRejection(rejection) {
  return typeof rejection.code === "number" && EIP1193_CODES[rejection.code] === true && typeof rejection.message === "string";
}
export function isNoiseEvent(event) {
  const frames = event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];
  if (frames.length === 0) {
    const serialized = event.extra?.__serialized__;
    if (typeof serialized !== "object" || serialized === null) {
      return false;
    }
    const rejection = serialized;
    return isExtensionSerializedStack(rejection) || isWalletProviderRejection(rejection);
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
