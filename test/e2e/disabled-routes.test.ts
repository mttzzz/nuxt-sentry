import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetch, setup, useTestContext } from '@nuxt/test-utils/e2e'
import { describe, expect, it, vi } from 'vitest'

import { version } from '../../package.json'
import { buildEarlyBeaconScript } from '../../src/runtime/utils/early-beacon'

/* Release вшивается в ранний inline-beacon при сборке: фиксируем, чтобы тест не зависел от окружения запуска. */
vi.stubEnv('SENTRY_RELEASE', 'e2e-release')

await setup({
  rootDir: fileURLToPath(new URL('../fixtures/disabled-routes', import.meta.url)),
})

const DISABLED_ROUTES = ['/clients/**', '/share/*']
const BEACON_OPTIONS = {
  dsn: 'https://test-key@o0.ingest.sentry.io/9999',
  tunnelEndpoint: '/api/sentry-tunnel',
  release: 'e2e-release',
  excludeLocalhostInProd: true,
  version,
}

describe('module e2e — fixture: disabled-routes (sentry.client.disabledRoutes)', () => {
  it('ранний inline-beacon: в <head> скрипт с гейтом и паттернами, байт в байт как собранный buildEarlyBeaconScript', async () => {
    /*
     * Опция client.disabledRoutes обязана дойти из nuxt.config до buildEarlyBeaconScript. Сверка с функцией целиком
     * ловит и потерянную опцию (в HTML окажется скрипт без гейта), и искажение текста по пути через Nuxt/unhead.
     * Скрипт без опции в HTML появляться не должен: он тоже одиночный в head, и гейт — единственное отличие.
     */
    const response = await fetch('/')
    const html = await response.text()
    const script = buildEarlyBeaconScript({ ...BEACON_OPTIONS, disabledRoutes: DISABLED_ROUTES })

    expect(html.split(script)).toHaveLength(2)
    expect(html.indexOf(script)).toBeLessThan(html.indexOf('</head>'))
    expect(html.includes(buildEarlyBeaconScript(BEACON_OPTIONS))).toBe(false)
  })

  it('виртуальный модуль #nuxt-sentry/config экспортирует disabledRoutes для клиентского плагина', async () => {
    const { nuxt } = useTestContext()
    const template = await readFile(join(nuxt!.options.buildDir, 'nuxt-sentry-build-config.mjs'), 'utf8')

    expect(template).toContain(`export const disabledRoutes = ${JSON.stringify(DISABLED_ROUTES)}`)
  })

  it('паттерны доехали до собранного клиента: плагин импортирует их из #nuxt-sentry/config', async () => {
    const { nuxt } = useTestContext()
    const assets = join(nuxt!.options.buildDir, 'output', 'public', '_nuxt')
    const names = await readdir(assets)
    const bundles = await Promise.all(
      names.filter((name) => name.endsWith('.js')).map((name) => readFile(join(assets, name), 'utf8')),
    )

    expect(bundles.some((code) => DISABLED_ROUTES.every((pattern) => code.includes(JSON.stringify(pattern))))).toBe(
      true,
    )
  })
})
