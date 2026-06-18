import type { Event } from '@sentry/core'

const EXTENSION_PROTOCOL = /^(?:chrome|moz|safari(?:-web)?)-extension:\/\//u

/* Фрейм «не наш»: анонимный (<anonymous>/пусто) или из браузерного расширения. */
function isNoiseFrame(filename = ''): boolean {
  return filename === '' || filename === '<anonymous>' || EXTENSION_PROTOCOL.test(filename)
}

/*
 * Под catch-all (captureConsoleIntegration) message-based `ignoreErrors` НЕ ловит шум
 * с нормальным сообщением, но мусорным стеком: браузерное расширение рекурсивно патчит
 * глобал (напр. Object.getOwnPropertyDescriptor) → RangeError со стеком из одних анонимных
 * фреймов (issue KP-MODMB-COM-M). Дропаем event, если ВЕСЬ стек — не наши фреймы.
 * Event без exception/стека (обычный лог/сообщение) не трогаем.
 */
export function isNoiseEvent(event: Event): boolean {
  const frames = event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? []
  if (frames.length === 0) {
    return false
  }
  return frames.every((frame) => isNoiseFrame(frame.filename))
}
