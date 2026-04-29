import { fileURLToPath } from 'node:url'

import { fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

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
})
