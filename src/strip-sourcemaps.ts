import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

import { useLogger } from '@nuxt/kit'

/*
 * Серверные карты — `.output/server` после сборки Nitro. Карты нужны Sentry на загрузке, а не рантайму: под стартует без
 * `--enable-source-maps`, остаются они только мёртвым грузом — в реестр каждым деплоем уезжают десятки МБ (у ai.pushka.biz
 * 51 MB из 178 MB слоя `.output`, пуш слоёв и есть главная статья времени деплоя; замер 13.08: 28–260 s).
 *
 * Плагин загрузки карт Sentry (`@sentry/vite-plugin`) здесь не участвует: это бандл Nitro (Rollup), а не Vite. Клиентские
 * карты (`.output/public`, до 0.16.0 их чистил хук `nitro:build:public-assets`) убирает сам плагин опцией
 * `sourcemaps.deleteSourcemapsAfterUpload`: карта не пишется в выходной каталог Vite вовсе — см. module.ts.
 *
 * Если появится загрузка серверных карт в Sentry, она обязана отработать ДО этой чистки.
 */

/* `.map` и его сжатые копии (compressPublicAssets кладёт `.map.gz`/`.map.br` рядом). */
const MAP_FILE = /\.map(?:\.(?:gz|br|zst))?$/u

async function removeMapFiles(dir: string): Promise<number> {
  if (!existsSync(dir)) {
    return 0
  }
  const entries = await readdir(dir, { recursive: true })
  const maps = entries.filter((entry) => MAP_FILE.test(entry))
  await Promise.all(maps.map(async (entry) => rm(resolvePath(dir, entry), { force: true })))
  return maps.length
}

/* Серверные карты: `.output/server` после сборки Nitro (hook `compiled`). */
export async function stripServerSourcemaps(rootDir: string): Promise<number> {
  const removed = await removeMapFiles(resolvePath(rootDir, '.output', 'server'))
  if (removed > 0) {
    useLogger('sentry').info(`удалено серверных sourcemap'ов из .output: ${removed}`)
  }
  return removed
}
