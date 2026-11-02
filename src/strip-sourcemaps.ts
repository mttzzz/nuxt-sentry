import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

import { useLogger } from '@nuxt/kit'

/*
 * Карты нужны Sentry на загрузке, а не рантайму: под стартует без `--enable-source-maps`, браузеру их никто не отдаёт
 * (client.sourcemap: 'hidden' — без комментария sourceMappingURL). Остаются они только мёртвым грузом и утечкой исходников:
 *   - серверные — после сборки Nitro, в реестр каждым деплоем уезжают десятки МБ (у ai.pushka.biz 51 MB из 178 MB слоя
 *     `.output`, пуш слоёв и есть главная статья времени деплоя; замер 13.08: 28–260 s);
 *   - клиентские — лежат в `.output/public/_nuxt` и отдаются ПУБЛИЧНО: и самим сервером, и с CDN, если публикатор ассетов
 *     заливает всё, что лежит в `public` (у ai.pushka.biz — 630 карт, 46 МБ из 69 МБ каталога, с `sourcesContent`).
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

/*
 * Клиентские карты: публичный каталог Nitro (`nitro.options.output.publicDir`, .output/public).
 *
 * Момент — hook `nitro:build:public-assets`: Nitro уже скопировал клиентскую сборку (`<buildDir>/dist/client` → .output/public)
 * и ещё не собирал манифест публичных ассетов. Раньше нельзя: Vite-плагин Sentry загружает карты и чистит файлы в
 * `writeBundle` клиентской сборки, а `.output/public` на этот момент ещё не существует (Nitro копирует его позже) —
 * глоб `.output/**\/*.map` не находил ничего, и все карты уезжали в образ и на CDN. Позже нельзя: манифест (в бандле
 * сервера) перечислил бы удалённые файлы, и запрос карты кончался бы ошибкой чтения вместо 404.
 */
export async function stripPublicSourcemaps(publicDir: string): Promise<number> {
  const removed = await removeMapFiles(publicDir)
  if (removed > 0) {
    useLogger('sentry').info(`удалено клиентских sourcemap'ов из публичного каталога сборки: ${removed}`)
  }
  return removed
}
