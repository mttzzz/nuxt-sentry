import type { Event } from '@sentry/core'
import { describe, expect, it } from 'vitest'

import { isNoiseEvent, normalizeConsoleEvent, normalizeMessageEvent } from '../../src/runtime/utils/before-send'

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

  it('снимает synthetic: заголовок и группировка берут type/value, а не функцию кадра', () => {
    /* Вызов captureMessage(…, { syntheticException }) ставит mechanism.synthetic = true, и сервер
     * Sentry при этом НЕ кладёт type в metadata: заголовок = функция crash-location
     * («consoleHandler» из @sentry/core), value в группировке не участвует. Прод ai.pushka.biz
     * 04.09 (AI-PUSHKA-BIZ-5J): три разных console.error в одном issue с таким заголовком. */
    const value = normalizeConsoleEvent(consoleEvent('error')).exception!.values![0]!

    expect(value.mechanism).toEqual({ type: 'auto.core.capture_console', handled: true, synthetic: false })
  })

  it('останавливается сразу за кадром warn/error: анонимный вызывающий остаётся прикладным', () => {
    /* Каждый .catch((err) => logger.error(…)) — анонимный кадр прямо под error. Гасить его как
     * sink нельзя: без него у события нет ни одного прикладного кадра, и все такие места
     * приложения группируются в один issue по одинаковому стеку обвязки. */
    const frames = [
      { function: '<anonymous>', filename: 'app:///server/index.mjs', lineno: 9000, colno: 5, in_app: true },
      { function: 'error', filename: 'app:///server/index.mjs', lineno: 5487, colno: 14, in_app: true },
      { function: 'withSourceScope', filename: 'app:///server/index.mjs', lineno: 5501, colno: 12, in_app: true },
      { function: 'run', filename: 'node:async_hooks', lineno: 99, colno: 29, in_app: false },
      { function: '<anonymous>', filename: 'app:///server/index.mjs', lineno: 5504, colno: 7, in_app: true },
      { function: 'output', filename: 'app:///server/index.mjs', lineno: 5498, colno: 14, in_app: true },
      {
        function: 'consoleHandler',
        filename: 'app:///server/node_modules/@sentry/core/build/esm/integrations/captureconsole.js',
        lineno: 33,
        colno: 34,
        in_app: false,
      },
    ]
    const event: Event = {
      level: 'error',
      logger: 'console',
      exception: {
        values: [
          {
            value: '[t] boom',
            stacktrace: { frames },
            mechanism: { type: 'auto.core.capture_console', handled: true, synthetic: true },
          },
        ],
      },
    }

    const out = normalizeConsoleEvent(event).exception!.values![0]!.stacktrace!.frames!

    expect(out.map((frame) => frame.in_app)).toEqual([true, false, false, false, false, false, false])
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

/* Форма core eventFromMessage под attachStacktrace: true — прод ai.pushka.biz AI-PUSHKA-BIZ-5Q:
 * Sentry.captureMessage('Обратная связь от …', { level: 'info', fingerprint }) из announceFeedback
 * уехал typeless synthetic-исключением, и сервер озаглавил issue «announceFeedback». */
function messageFrames() {
  return [
    {
      function: '<anonymous>',
      filename: 'app:///server/chunks/routes/api/index.post.mjs',
      lineno: 127,
      colno: 3,
      in_app: true,
    },
    {
      function: 'announceFeedback',
      filename: 'app:///server/chunks/routes/api/index.post.mjs',
      lineno: 87,
      colno: 12,
      in_app: true,
    },
  ]
}

function messageEvent(): Event {
  return {
    level: 'info',
    message: 'Обратная связь от user@example.com: светлая тема',
    fingerprint: ['feedback-suggestion', 'nd8ku7vokx9arb7pcptjba85'],
    exception: {
      values: [
        {
          value: 'Обратная связь от user@example.com: светлая тема',
          stacktrace: { frames: messageFrames() },
          mechanism: { type: 'generic', handled: true, synthetic: true },
        },
      ],
    },
  }
}

describe('normalizeMessageEvent', () => {
  it('captureMessage под attachStacktrace становится message-событием: стек уходит в threads', () => {
    const event = normalizeMessageEvent(messageEvent())

    /* Без exception relay даёт тип default: заголовок — сообщение, не функция кадра. */
    expect(event.exception).toBeUndefined()
    expect(event.message).toBe('Обратная связь от user@example.com: светлая тема')
    expect(event.fingerprint).toEqual(['feedback-suggestion', 'nd8ku7vokx9arb7pcptjba85'])
    expect(event.threads).toEqual({
      values: [{ stacktrace: { frames: messageFrames() }, crashed: false, current: true }],
    })
  })

  it('console-событие остаётся exception с type console.<level> независимо от порядка нормализаторов', () => {
    const alone = normalizeMessageEvent(consoleEvent('error'))
    expect(alone.threads).toBeUndefined()
    expect(alone.exception!.values![0]!.mechanism).toEqual({
      type: 'auto.core.capture_console',
      handled: true,
      synthetic: true,
    })

    const composed = normalizeMessageEvent(normalizeConsoleEvent(consoleEvent('error')))
    expect(composed.threads).toBeUndefined()
    expect(composed.exception!.values![0]!.type).toBe('console.error')
  })

  it('не трогает typed synthetic-исключение (captureException со строкой) и настоящую ошибку', () => {
    const fromString: Event = {
      level: 'error',
      exception: {
        values: [
          {
            type: 'Error',
            value: 'boom',
            stacktrace: { frames: messageFrames() },
            mechanism: { type: 'generic', handled: true, synthetic: true },
          },
        ],
      },
    }
    const real: Event = {
      level: 'error',
      message: 'контекст',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'x is not a function',
            stacktrace: { frames: messageFrames() },
            mechanism: { type: 'generic', handled: true },
          },
        ],
      },
    }

    for (const event of [fromString, real]) {
      const before = structuredClone(event)
      expect(normalizeMessageEvent(event)).toEqual(before)
    }
  })
})
