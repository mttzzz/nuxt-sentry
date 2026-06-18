import { describe, expect, it } from 'vitest'

import { isNoiseEvent } from '../../src/runtime/utils/before-send'

/* Реальная сигнатура из KP-MODMB-COM-M: браузерное расширение рекурсивно патчит
 * Object.getOwnPropertyDescriptor → стек из одних анонимных _getOwnPropertyDescriptor. */
function extensionFrames(n: number) {
  return Array.from({ length: n }, () => ({
    function: 'Object.getOwnPropertyDescriptor [as _getOwnPropertyDescriptor]',
    filename: '<anonymous>',
    lineno: 1,
    colno: 3085,
  }))
}

describe('isNoiseEvent', () => {
  it('дропает extension-рекурсию (все фреймы <anonymous>)', () => {
    const event = { exception: { values: [{ type: 'RangeError', stacktrace: { frames: extensionFrames(48) } }] } }
    expect(isNoiseEvent(event)).toBe(true)
  })

  it('дропает стек из chrome-extension:// фреймов', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            stacktrace: {
              frames: [
                { function: 'x', filename: 'chrome-extension://abc/content.js', lineno: 1, colno: 2 },
                { function: 'y', filename: 'chrome-extension://abc/content.js', lineno: 3, colno: 4 },
              ],
            },
          },
        ],
      },
    }
    expect(isNoiseEvent(event)).toBe(true)
  })

  it('пропускает настоящую ошибку приложения (реальные filename)', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'TypeError',
            stacktrace: {
              frames: [
                { function: 'loadMore', filename: 'app://app/composables/useInfiniteTable.ts', lineno: 200, colno: 5 },
                { function: 'fetchPage', filename: 'app://app/composables/useInfiniteTable.ts', lineno: 188, colno: 7 },
              ],
            },
          },
        ],
      },
    }
    expect(isNoiseEvent(event)).toBe(false)
  })

  it('пропускает event без стека (не трогаем)', () => {
    expect(isNoiseEvent({ message: 'plain log' })).toBe(false)
    expect(isNoiseEvent({ exception: { values: [{ type: 'Error', stacktrace: { frames: [] } }] } })).toBe(false)
  })
})
