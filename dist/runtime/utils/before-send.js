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
