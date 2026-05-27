import { describe, expect, it } from 'vitest'

import {
  IGNORED_MANIFEST_POLL_ERRORS,
  IGNORED_VIEW_TRANSITION_ERRORS,
  buildIgnoreErrors,
  isIgnoredSentryMessage,
} from '../../src/runtime/utils/ignore-errors'

describe('IGNORED_VIEW_TRANSITION_ERRORS', () => {
  it.each([
    'Transition was aborted by another navigation',
    'Transition was skipped (cancelled)',
    'skipTransition() was called',
    'View transition update callback timed out',
    'document visibility state was hidden',
    'Skipped ViewTransition due to document being hidden',
  ])('matches: %s', (msg) => {
    expect(IGNORED_VIEW_TRANSITION_ERRORS.some((p) => p.test(msg))).toBe(true)
  })

  it('пропускает безопасные сообщения', () => {
    expect(IGNORED_VIEW_TRANSITION_ERRORS.some((p) => p.test('TypeError: cannot read property of null'))).toBe(false)
  })
})

describe('IGNORED_MANIFEST_POLL_ERRORS', () => {
  it.each([
    '[GET] "https://app/_nuxt/builds/meta/abc123.json": <no response> Load failed',
    '[GET] "/_nuxt/builds/latest.json": Network timeout',
    '[POST] "/_nuxt/builds/meta/x.json": failed',
  ])('matches manifest-poll (raw exception message): %s', (msg) => {
    expect(IGNORED_MANIFEST_POLL_ERRORS.some((p) => p.test(msg))).toBe(true)
  })

  /*
   * Регресс kp.modmb.com (30 logs / 4 дня): log-канал
   * (consoleLoggingIntegration) сериализует FetchError через
   * `String(arg0) + ' ' + JSON.stringify(normalize(err))`. JSON.stringify
   * экранирует кавычки вокруг URL → `\"`. Старый паттерн с литеральным `] "`
   * (без возможного бэкслеша) не матчил это, и manifest-poll шум утекал в
   * Sentry Logs, хотя как exception (raw message) он корректно фильтровался.
   * Воспроизводим тем же путём сериализации, что и SDK.
   */
  it.each([
    '[GET] "/_nuxt/builds/meta/4a5f1730-7759-4587-9f1d-9538e7318152.json": <no response> Load failed',
    '[GET] "/_nuxt/builds/latest.json": <no response> Failed to fetch',
  ])('matches manifest-poll (JSON-escaped console-log body): %s', (rawMessage) => {
    const body = `[nuxt] Error fetching app manifest. ${JSON.stringify({ message: rawMessage, name: 'FetchError', stack: 'Zn@https://kp.modmb.com/_nuxt/x.js:1:2' })}`
    expect(IGNORED_MANIFEST_POLL_ERRORS.some((p) => p.test(body))).toBe(true)
  })

  it('не матчит обычные API-ошибки', () => {
    expect(IGNORED_MANIFEST_POLL_ERRORS.some((p) => p.test('[GET] "/api/users": 500'))).toBe(false)
  })
})

describe('buildIgnoreErrors', () => {
  it('включает view-transition + stale-chunk + manifest-poll по дефолту', () => {
    const all = buildIgnoreErrors()
    /* Самый минимум: длина >= суммы view-transition + manifest-poll. */
    expect(all.length).toBeGreaterThanOrEqual(
      IGNORED_VIEW_TRANSITION_ERRORS.length + IGNORED_MANIFEST_POLL_ERRORS.length,
    )
  })

  it('добавляет дополнительные паттерны в конец', () => {
    const custom = /custom-pattern/u
    const all = buildIgnoreErrors([custom, 'literal-substring'])
    expect(all).toContain(custom)
    expect(all).toContain('literal-substring')
  })
})

describe('isIgnoredSentryMessage', () => {
  it('детектит view-transition noise', () => {
    expect(isIgnoredSentryMessage('Transition was aborted')).toBe(true)
  })

  it('пропускает реальные ошибки', () => {
    expect(isIgnoredSentryMessage('ReferenceError: foo is not defined')).toBe(false)
  })

  it('применяет custom-паттерны', () => {
    expect(isIgnoredSentryMessage('my-app: noisy thing', [/noisy/u])).toBe(true)
  })

  it('строковый паттерн матчится как substring', () => {
    expect(isIgnoredSentryMessage('Error: Quota exceeded', ['Quota'])).toBe(true)
  })

  it('детектит JSON-escaped manifest-poll log body (beforeSendLog путь)', () => {
    const body = `[nuxt] Error fetching app manifest. ${JSON.stringify({ message: '[GET] "/_nuxt/builds/meta/4a5f1730-7759-4587-9f1d-9538e7318152.json": <no response> Load failed', name: 'FetchError' })}`
    expect(isIgnoredSentryMessage(body)).toBe(true)
  })
})
