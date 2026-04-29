/*
 * Regex-паттерны для Sentry `ignoreErrors` — известный noise, не функциональные баги.
 *
 * Stale-chunk паттерны (chunk-reload после deploy) живут в `@mttzzz/nuxt-stale-deploy-guard/sentry`.
 * Поскольку nuxt-sentry заведомо ставится вместе со stale-deploy-guard'ом, мы импортим
 * `STALE_CHUNK_PATTERNS` оттуда. Если консьюмер по какой-то причине не использует
 * stale-deploy-guard, импорт failфаст'ится — это явный сигнал.
 */

import { STALE_CHUNK_PATTERNS } from '@mttzzz/nuxt-stale-deploy-guard/sentry'

export const IGNORED_VIEW_TRANSITION_ERRORS: RegExp[] = [
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
  /Skipped ViewTransition/i,
]

/*
 * Nuxt каждые `experimental.checkOutdatedBuildInterval` мс фетчит
 * `/_nuxt/builds/meta/<id>.json` и `/_nuxt/builds/latest.json` для детекта
 * устаревшего build'а. На мобильном iOS Safari/Chrome при lock screen, смене
 * сети или переходе в background этот фоновый fetch умирает с
 * `<no response> Load failed` — это network hiccup, не функциональный баг.
 * Формулировка в сообщении ofetch: `[GET] "<url>": <reason>`.
 */
export const IGNORED_MANIFEST_POLL_ERRORS: RegExp[] = [
  /\[[A-Z]+\] "[^"]*\/_nuxt\/builds\/(meta\/[^"]+|latest)\.json"/i,
]

export function buildIgnoreErrors(additional: (string | RegExp)[] = []): (string | RegExp)[] {
  return [
    ...IGNORED_VIEW_TRANSITION_ERRORS,
    ...STALE_CHUNK_PATTERNS,
    ...IGNORED_MANIFEST_POLL_ERRORS,
    ...additional,
  ]
}

export function isIgnoredSentryMessage(
  message: string,
  additional: (string | RegExp)[] = [],
): boolean {
  const all = buildIgnoreErrors(additional)
  return all.some((pattern) => {
    if (typeof pattern === 'string') return message.includes(pattern)
    return pattern.test(message)
  })
}
