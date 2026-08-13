import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

import { useLogger } from '@nuxt/kit'

/*
 * Серверные sourcemap'ы после сборки Nitro никому не нужны:
 *   - в Sentry уезжает только клиентский бандл (vite-плагин), серверные карты не загружаются;
 *   - под стартует без `--enable-source-maps`, читать их некому;
 *   - зато они уезжают в реестр каждым деплоем — у ai.pushka.biz это 51 MB из 178 MB слоя
 *     `.output`, а пуш слоёв и есть главная статья времени деплоя (замер 13.08: 28–260 s,
 *     разброс задаёт реестр).
 *
 * Если появится загрузка серверных карт в Sentry, она обязана отработать ДО этой чистки.
 */
export async function stripServerSourcemaps(rootDir: string): Promise<number> {
  const serverDir = resolvePath(rootDir, '.output', 'server')
  if (!existsSync(serverDir)) {
    return 0
  }
  const entries = await readdir(serverDir, { recursive: true })
  const maps = entries.filter((entry) => entry.endsWith('.map'))
  await Promise.all(maps.map(async (entry) => rm(resolvePath(serverDir, entry), { force: true })))
  if (maps.length > 0) {
    useLogger('sentry').info(`удалено серверных sourcemap'ов из .output: ${maps.length}`)
  }
  return maps.length
}
