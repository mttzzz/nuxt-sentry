import { fileURLToPath } from 'node:url'

import { loadNuxt } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'

const rootDir = fileURLToPath(new URL('../fixtures/disabled-routes', import.meta.url))

describe('module setup — sentry.client.disabledRoutes: неподдерживаемый паттерн', () => {
  /*
   * В dev скрипта beacon нет, поэтому ошибку в этом режиме бросает только разбор паттернов на setup модуля;
   * в production её бросил бы и сборщик beacon'а. В обоих режимах — до сборки и до браузера.
   */
  it.each([true, false])('опечатка падает при setup модуля, а не в браузере (dev: %s)', async (dev) => {
    await expect(
      loadNuxt({
        cwd: rootDir,
        dev,
        overrides: { sentry: { client: { disabledRoutes: ['/a/**/b'] } } },
      }),
    ).rejects.toThrow('sentry.client.disabledRoutes: unsupported pattern "/a/**/b"')
  })
})
