import { fileURLToPath } from 'node:url'

import { fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it, vi } from 'vitest'

import { version } from '../../package.json'
import { buildEarlyBeaconScript } from '../../src/runtime/utils/early-beacon'

/* Release вшивается в ранний inline-beacon при сборке: фиксируем, чтобы тест не зависел от окружения запуска. */
vi.stubEnv('SENTRY_RELEASE', 'e2e-release')

await setup({
  rootDir: fileURLToPath(new URL('../fixtures/default', import.meta.url)),
})

describe('module e2e — fixture: default (NUXT_TEST_MODE=1)', () => {
  it('runtimeConfig.public.sentry — заполнен из module options', async () => {
    /*
     * Проверяем через эндпойнт: запрашиваем сам tunnel — он gate'ит при testMode=true
     * и возвращает 204. Это самая «дешёвая» дымовая проверка что:
     *   - module прокинул `tunnelEndpoint` в роуты,
     *   - tunnel-handler читает testMode из runtimeConfig и срабатывает гейт.
     */
    const res = await fetch('/api/sentry-tunnel', {
      method: 'POST',
      body: 'envelope-mock',
      headers: { 'content-type': 'application/x-sentry-envelope' },
    })
    expect(res.status).toBe(204)
  })

  it('GET /api/__throw → 500 (unhandled), nitro `error` хук вызван без падения сервера', async () => {
    /*
     * Если capture-errors-плагин кривой (например, кидает изнутри хука), nitro
     * сам выпадает. Достаточно того, что после 500-ки сервер всё ещё отвечает на
     * следующий запрос.
     */
    const res = await fetch('/api/__throw')
    expect(res.status).toBe(500)

    const probe = await fetch('/api/sentry-tunnel', {
      method: 'POST',
      body: 'envelope-mock',
    })
    expect(probe.status).toBe(204)
  })

  it('ранний inline-beacon: в <head> HTML-оболочки один раз и байт в байт как собранный скриптом', async () => {
    /*
     * Продакшен-сборка фикстуры (nuxt.options.dev = false) обязана положить скрипт в head со вшитыми
     * DSN/tunnel. Сверка с buildEarlyBeaconScript целиком ловит и пропажу скрипта, и искажение его
     * текста по пути через Nuxt/unhead (экранирование `&&`, `<`).
     */
    const response = await fetch('/')
    const html = await response.text()
    const script = buildEarlyBeaconScript({
      dsn: 'https://test-key@o0.ingest.sentry.io/9999',
      tunnelEndpoint: '/api/sentry-tunnel',
      release: 'e2e-release',
      excludeLocalhostInProd: true,
      version,
    })

    expect(html.split(script)).toHaveLength(2)
    expect(html.indexOf(script)).toBeLessThan(html.indexOf('</head>'))
  })
})
