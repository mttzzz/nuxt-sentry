import { describe, expect, it } from 'vitest'

import { shouldEnableClientSentry, shouldEnableServerSentry } from '../../src/runtime/utils/sentry-enabled'

describe('shouldEnableServerSentry', () => {
  it('NODE_ENV=production + SENTRY_DISABLED=undefined → true', () => {
    expect(shouldEnableServerSentry({ nodeEnv: 'production', sentryDisabled: undefined })).toBe(true)
  })

  it('NODE_ENV=production + SENTRY_DISABLED=1 → false (test-image gate)', () => {
    expect(shouldEnableServerSentry({ nodeEnv: 'production', sentryDisabled: '1' })).toBe(false)
  })

  it('NODE_ENV=development → false', () => {
    expect(shouldEnableServerSentry({ nodeEnv: 'development', sentryDisabled: undefined })).toBe(false)
  })

  it('NODE_ENV=test → false', () => {
    expect(shouldEnableServerSentry({ nodeEnv: 'test', sentryDisabled: undefined })).toBe(false)
  })

  it('NODE_ENV=undefined → false', () => {
    expect(shouldEnableServerSentry({ nodeEnv: undefined, sentryDisabled: undefined })).toBe(false)
  })

  it('SENTRY_DISABLED=0 (string) НЕ воспринимается как off (только "1" гасит)', () => {
    expect(shouldEnableServerSentry({ nodeEnv: 'production', sentryDisabled: '0' })).toBe(true)
  })
})

describe('shouldEnableClientSentry', () => {
  it('isProd=false → false', () => {
    expect(shouldEnableClientSentry({ isProd: false, hostname: 'example.com', excludeLocalhost: true })).toBe(false)
  })

  it('isProd=true + хостнейм публичный → true', () => {
    expect(shouldEnableClientSentry({ isProd: true, hostname: 'easy2.pushka.biz', excludeLocalhost: true })).toBe(true)
  })

  it('isProd=true + 127.0.0.1 + excludeLocalhost=true → false', () => {
    expect(shouldEnableClientSentry({ isProd: true, hostname: '127.0.0.1', excludeLocalhost: true })).toBe(false)
  })

  it('isProd=true + localhost + excludeLocalhost=true → false', () => {
    expect(shouldEnableClientSentry({ isProd: true, hostname: 'localhost', excludeLocalhost: true })).toBe(false)
  })

  it('isProd=true + 127.0.0.1 + excludeLocalhost=false → true (опт-аут гейта)', () => {
    expect(shouldEnableClientSentry({ isProd: true, hostname: '127.0.0.1', excludeLocalhost: false })).toBe(true)
  })

  it('покрывает 0.0.0.0 и ::1', () => {
    expect(shouldEnableClientSentry({ isProd: true, hostname: '0.0.0.0', excludeLocalhost: true })).toBe(false)
    expect(shouldEnableClientSentry({ isProd: true, hostname: '::1', excludeLocalhost: true })).toBe(false)
  })
})
