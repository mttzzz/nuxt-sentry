import { STALE_CHUNK_PATTERNS } from "@mttzzz/nuxt-stale-deploy-guard/sentry";
export const IGNORED_VIEW_TRANSITION_ERRORS = [
  /Transition was aborted/,
  /Transition was skipped/,
  /skipTransition\(\) was called/,
  /View transition update callback timed out/,
  /document visibility state/,
  /*
   * Firefox 149+ при `document.visibilityState === 'hidden'` во время навигации
   * реджектит promise из `startViewTransition()` с
   * `InvalidStateError: Skipped ViewTransition due to document being hidden`.
   * Nuxt view-transitions плагин не .catch()-ает этот promise, и reject долетает
   * в Sentry как unhandledrejection. По spec, не баг.
   */
  /Skipped ViewTransition/i
];
export const IGNORED_MANIFEST_POLL_ERRORS = [
  /\[[A-Z]+\] "[^"]*\/_nuxt\/builds\/(meta\/[^"]+|latest)\.json"/i
];
export function buildIgnoreErrors(additional = []) {
  return [
    ...IGNORED_VIEW_TRANSITION_ERRORS,
    ...STALE_CHUNK_PATTERNS,
    ...IGNORED_MANIFEST_POLL_ERRORS,
    ...additional
  ];
}
export function isIgnoredSentryMessage(message, additional = []) {
  const all = buildIgnoreErrors(additional);
  return all.some((pattern) => {
    if (typeof pattern === "string") return message.includes(pattern);
    return pattern.test(message);
  });
}
