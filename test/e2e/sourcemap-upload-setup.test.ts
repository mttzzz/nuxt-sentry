import { fileURLToPath } from 'node:url'

import { loadNuxt } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rootDir = fileURLToPath(new URL('../fixtures/default', import.meta.url))

/*
 * Сборка с SENTRY_AUTH_TOKEN: что модуль делает на setup. Настоящий Nuxt (loadNuxt) со сборочным окружением
 * (NODE_ENV=production, dev: false), без самой сборки: проверяются побочные эффекты setup, на которые опирается выкатка
 * (телеметрия CLI). Карты (загрузка и удаление после неё) проверяет sourcemap-build.test.ts настоящей сборкой.
 */

const TELEMETRY_VAR = 'SENTRY_CLI_NO_TELEMETRY'
const originalTelemetry = process.env[TELEMETRY_VAR]

async function withNuxt<T>(run: (nuxt: Nuxt) => T | Promise<T>): Promise<T> {
  const nuxt = await loadNuxt({ cwd: rootDir, dev: false })
  try {
    return await run(nuxt)
  } finally {
    await nuxt.close()
  }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SENTRY_RELEASE', '')
  delete process.env[TELEMETRY_VAR]
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalTelemetry === undefined) {
    delete process.env[TELEMETRY_VAR]
  } else {
    process.env[TELEMETRY_VAR] = originalTelemetry
  }
})

describe('телеметрия npm-CLI sentry внутри плагина загрузки карт', () => {
  it('сборка с токеном: SENTRY_CLI_NO_TELEMETRY=1 выставлена после setup, до запуска плагина', async () => {
    vi.stubEnv('SENTRY_AUTH_TOKEN', 'sntrys_test_token')

    await withNuxt(() => {
      expect(process.env[TELEMETRY_VAR]).toBe('1')
    })
  })

  it('явное значение пользователя не перетирается', async () => {
    vi.stubEnv('SENTRY_AUTH_TOKEN', 'sntrys_test_token')
    vi.stubEnv(TELEMETRY_VAR, '0')

    await withNuxt(() => {
      expect(process.env[TELEMETRY_VAR]).toBe('0')
    })
  })

  it('без токена CLI не запускается, и переменная не трогается', async () => {
    vi.stubEnv('SENTRY_AUTH_TOKEN', '')

    await withNuxt(() => {
      expect(process.env[TELEMETRY_VAR]).toBeUndefined()
    })
  })
})
