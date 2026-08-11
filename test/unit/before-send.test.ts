import type { Event } from '@sentry/core'
import { describe, expect, it } from 'vitest'

import { isNoiseEvent, normalizeConsoleEvent } from '../../src/runtime/utils/before-send'

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

/* Реальный стек console-warn из KP (issue «output»): порядок от старых фреймов к новым,
 * ПОСЛЕДНИЙ — верхний. Верхушка целиком принадлежит sink'у логгера, реальный вызывающий —
 * throttleRateLimitLog. `run` из node:async_hooks приходит от SDK уже с in_app: false. */
function consoleSinkFrames() {
  return [
    { function: 'fetchFromIpapi', filename: 'app:///server/utils/ip-geo.ts', lineno: 61, colno: 5, in_app: true },
    {
      function: 'throttleRateLimitLog',
      filename: 'app:///server/utils/ip-geo.ts',
      lineno: 44,
      colno: 3,
      in_app: true,
    },
    { function: 'warn', filename: 'app:///chunks/nuxt-sentry-logger.mjs', lineno: 52, colno: 9, in_app: true },
    {
      function: 'withSourceScope',
      filename: 'app:///chunks/nuxt-sentry-logger.mjs',
      lineno: 80,
      colno: 7,
      in_app: true,
    },
    { function: 'run', filename: 'node:async_hooks', lineno: 211, colno: 14, in_app: false },
    { function: '<anonymous>', filename: 'app:///chunks/sentry.mjs', lineno: 120, colno: 20, in_app: true },
    { function: '<anonymous>', filename: 'app:///chunks/sentry.mjs', lineno: 118, colno: 12, in_app: true },
    { function: 'output', filename: 'app:///chunks/nuxt-sentry-logger.mjs', lineno: 77, colno: 5, in_app: true },
  ]
}

function consoleEvent(level: 'warning' | 'error'): Event {
  return {
    level,
    logger: 'console',
    exception: {
      values: [
        {
          value: '[auth:ip-geo] ipapi rate-limited — отдаём fallback',
          stacktrace: { frames: consoleSinkFrames() },
          mechanism: { type: 'auto.core.capture_console', handled: true, synthetic: true },
        },
      ],
    },
  }
}

describe('normalizeConsoleEvent', () => {
  it('титулует warning-console-событие как console.warn', () => {
    const event = normalizeConsoleEvent(consoleEvent('warning'))

    expect(event.exception!.values![0]!.type).toBe('console.warn')
  })

  it('титулует error-console-событие как console.error', () => {
    const event = normalizeConsoleEvent(consoleEvent('error'))

    expect(event.exception!.values![0]!.type).toBe('console.error')
  })

  it("гасит in_app у фреймов sink'а, оставляя вызывающего верхним прикладным", () => {
    const frames = normalizeConsoleEvent(consoleEvent('warning')).exception!.values![0]!.stacktrace!.frames!
    const inApp = frames.filter((frame) => frame.in_app !== false).map((frame) => frame.function)

    /* Crash-location = верхний (последний) in_app-фрейм → culprit/metadata.function
     * = throttleRateLimitLog, а не output. */
    expect(inApp).toEqual(['fetchFromIpapi', 'throttleRateLimitLog'])
    expect(frames.map((frame) => frame.in_app)).toEqual([true, true, false, false, false, false, false, false])
  })

  it('не трогает typed exception (путь captureException) — ни type, ни in_app', () => {
    const event: Event = {
      level: 'error',
      logger: 'console',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'x is not a function',
            stacktrace: { frames: consoleSinkFrames() },
            mechanism: { type: 'auto.core.capture_console', handled: true },
          },
        ],
      },
    }
    const before = structuredClone(event)

    expect(normalizeConsoleEvent(event)).toEqual(before)
  })

  it('не трогает не-console событие (нет logger и console-mechanism)', () => {
    const event: Event = {
      level: 'error',
      exception: {
        values: [{ value: 'boom', stacktrace: { frames: consoleSinkFrames() }, mechanism: { type: 'onerror' } }],
      },
    }
    const before = structuredClone(event)

    expect(normalizeConsoleEvent(event)).toEqual(before)
  })

  it('не падает на событии без exception', () => {
    const event: Event = { level: 'warning', logger: 'console', message: 'plain log' }

    expect(normalizeConsoleEvent(event)).toEqual({ level: 'warning', logger: 'console', message: 'plain log' })
  })
})
