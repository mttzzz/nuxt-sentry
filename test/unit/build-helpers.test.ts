import { describe, expect, it } from 'vitest'

import { buildReplayTemplate } from '../../src/build-helpers'

/*
 * `sentry.replay: false` обязан убирать `@sentry/replay` из сборки целиком: единственная точка,
 * где он импортируется, — runtime/utils/session-replay.ts, и плагин добирается до неё только через
 * виртуальный модуль `#nuxt-sentry/replay`. Контракт: при false модуль не ссылается ни на файл
 * с импортом, ни на пакет, при true — реэкспортирует loadSessionReplay из файла с импортом.
 */
describe('buildReplayTemplate', () => {
  const runtimePath = '/abs/node_modules/@mttzzz/nuxt-sentry/dist/runtime/utils/session-replay'

  it('replay: true → реэкспорт loadSessionReplay из runtime-модуля с динамическим импортом', () => {
    const source = buildReplayTemplate(true, runtimePath)
    expect(source).toBe(`export { loadSessionReplay } from ${JSON.stringify(runtimePath)}\n`)
  })

  it('replay: false → no-op с той же сигнатурой, без единой ссылки на @sentry/replay', () => {
    const source = buildReplayTemplate(false, runtimePath)
    expect(source).toContain('export async function loadSessionReplay()')
    expect(source).not.toContain('session-replay')
    expect(source).not.toContain('@sentry/replay')
  })
})
