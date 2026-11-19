import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

/* Кроме Nitro ничего не мокаем: nitropack/runtime живёт только внутри сборки Nitro. */
vi.mock('nitropack/runtime', () => ({ defineTask: (task: unknown) => task }))

/*
 * Публичные subpath-экспорты пакета глазами потребителя: ai.pushka.biz импортировал `@mttzzz/nuxt-sentry/task` в своём
 * тесте, и пока закоммиченный dist (его ставит потребитель, `prepack` для github-зависимости не запускается) отдаёт
 * `defineSentryTask` и `runSentryTaskBody`, их контракт держит этот файл.
 */

interface ExportEntry {
  types: string
  import: string
}

const ROOT = new URL('../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as { exports: Record<string, ExportEntry> }

describe('subpath-экспорты пакета: закоммиченный dist', () => {
  it.each(Object.entries(pkg.exports))('%s: types и import указывают на существующие файлы', (_subpath, entry) => {
    expect(existsSync(new URL(entry.types, ROOT)), entry.types).toBe(true)
    expect(existsSync(new URL(entry.import, ROOT)), entry.import).toBe(true)
  })

  it('./task: defineSentryTask и runSentryTaskBody есть и в типах, и в значении, и работают', async () => {
    const entry = pkg.exports['./task']
    if (!entry) {
      throw new Error('В exports пакета нет ./task')
    }
    const declaration = readFileSync(new URL(entry.types, ROOT), 'utf8')
    expect(declaration).toContain('defineSentryTask')
    expect(declaration).toContain('runSentryTaskBody')

    const published = (await import(/* @vite-ignore */ fileURLToPath(new URL(entry.import, ROOT)))) as {
      defineSentryTask: unknown
      runSentryTaskBody: (args: unknown) => Promise<unknown>
    }
    expect(published.defineSentryTask).toBeTypeOf('function')
    const outcome = await published.runSentryTaskBody({
      meta: { name: 'public-contract' },
      run: () => Promise.resolve({ synced: 1 }),
      logger: { error: vi.fn() },
      sentry: {
        startNewTrace: (fn: () => Promise<unknown>) => fn(),
        startSpan: (_options: unknown, fn: () => Promise<unknown>) => fn(),
        withMonitor: (_slug: string, fn: () => Promise<unknown>) => fn(),
      },
    })
    expect(outcome).toEqual({ result: 'success', synced: 1 })
  })
})
