import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadNuxt } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rootDir = fileURLToPath(new URL('../fixtures/default', import.meta.url))

/*
 * Сборка с SENTRY_AUTH_TOKEN: что модуль делает на setup и в хуках сборки. Настоящий Nuxt (loadNuxt) со сборочным окружением
 * (NODE_ENV=production, dev: false), без самой сборки: проверяются побочные эффекты setup и поведение зарегистрированных
 * хуков, на которые опирается выкатка (карты в образ/на CDN, телеметрия CLI).
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

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .toSorted()
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

describe('клиентские sourcemap после загрузки в Sentry', () => {
  let publicDir = ''

  /* Публичный каталог Nitro сразу после копирования клиентской сборки: чанки, их карты, сжатые копии, шрифты, корень. */
  beforeEach(async () => {
    publicDir = await mkdtemp(join(tmpdir(), 'nuxt-sentry-public-'))
    await mkdir(join(publicDir, '_nuxt', 'builds'), { recursive: true })
    await mkdir(join(publicDir, '_fonts'), { recursive: true })
    const files = [
      '_nuxt/abc123.js',
      '_nuxt/abc123.js.map',
      '_nuxt/entry.css',
      '_nuxt/chunk.mjs.map.gz',
      '_nuxt/chunk.mjs.map.br',
      '_nuxt/builds/latest.json',
      '_fonts/font.woff2',
      'favicon.ico',
    ]
    await Promise.all(files.map(async (file) => writeFile(join(publicDir, file), 'x')))
  })

  afterEach(async () => {
    await rm(publicDir, { recursive: true, force: true })
  })

  it('хук nitro:build:public-assets убирает карты (и их сжатые копии), остальное не трогает', async () => {
    vi.stubEnv('SENTRY_AUTH_TOKEN', 'sntrys_test_token')

    await withNuxt(async (nuxt) => {
      await nuxt.callHook('nitro:build:public-assets', { options: { output: { publicDir } } } as never)
    })

    expect(await listFiles(publicDir)).toEqual([
      '_fonts/font.woff2',
      '_nuxt/abc123.js',
      '_nuxt/builds/latest.json',
      '_nuxt/entry.css',
      'favicon.ico',
    ])
  })

  it('без токена карты не выгружались — и не удаляются (их может забрать отдельный шаг сборки)', async () => {
    vi.stubEnv('SENTRY_AUTH_TOKEN', '')

    await withNuxt(async (nuxt) => {
      await nuxt.callHook('nitro:build:public-assets', { options: { output: { publicDir } } } as never)
    })

    expect(await listFiles(publicDir)).toContain('_nuxt/abc123.js.map')
  })
})
