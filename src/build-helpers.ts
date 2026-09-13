import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/*
 * Сериализация значения в JS-литерал для build-time inline в `nitro.replace` /
 * `vite.define`. JSON.stringify теряет RegExp, поэтому собираем литералы вручную:
 *   string  → "..."
 *   RegExp  → /pattern/flags
 *   number/boolean → стандарт
 *   array   → [el1, el2, ...]
 */
/*
 * Резолвим Nuxt-style path к абсолютному filesystem пути:
 *   ~~/...  → rootDir + ...  (project root)
 *   ~/...   → srcDir + ...   (Nuxt 4: app/)
 *   @/...   → srcDir + ...   (alias of ~)
 *   /abs    → as-is
 *   ./rel   → resolve from rootDir
 *
 * Возвращает абсолютный путь без расширения (Rollup/Vite сами добавят .ts/.mjs/.js).
 * Если ничего не нашлось на FS — возвращает null, чтобы caller выдал понятную ошибку.
 */
export function resolveSourcePath(userPath: string, rootDir: string, srcDir: string): string | null {
  let absolute: string
  if (userPath.startsWith('~~/')) {
    absolute = resolvePath(rootDir, userPath.slice(3))
  } else if (userPath.startsWith('~/') || userPath.startsWith('@/')) {
    absolute = resolvePath(srcDir, userPath.slice(2))
  } else if (isAbsolute(userPath)) {
    absolute = userPath
  } else {
    absolute = resolvePath(rootDir, userPath)
  }
  for (const ext of ['', '.ts', '.mts', '.js', '.mjs']) {
    if (existsSync(absolute + ext)) {
      return absolute
    }
  }
  return null
}

/*
 * Virtual modules для error-pipeline customization. Если опция не задана —
 * экспортим no-op default. Если задана — re-export через АБСОЛЮТНЫЙ путь
 * (Rollup в Nitro production-build не всегда понимает Nuxt-aliases внутри
 * .nuxt/cache template'ов, поэтому резолвим заранее).
 */
export function buildVirtualReexport(absoluteSourcePath: string | null, fallback: string): string {
  if (absoluteSourcePath) {
    return `export { default } from ${JSON.stringify(absoluteSourcePath)}\n`
  }
  return `export default ${fallback}\n`
}

export function serializeBuildLiteral(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeBuildLiteral(v)).join(',')}]`
  }
  if (value instanceof RegExp) {
    return value.toString()
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (value === null || value === undefined) {
    return 'undefined'
  }
  return JSON.stringify(value)
}

/*
 * Содержимое виртуального модуля `#nuxt-sentry/replay`, который импортирует plugin.client.ts.
 * `replay: true` — реэкспорт loadSessionReplay из runtime/utils/session-replay (там живёт
 * `import('@sentry/replay')` → отдельный чанк). `replay: false` — no-op с той же сигнатурой:
 * динамического импорта в бандле нет, rolldown не эмитит чанк rrweb, рендерер Nuxt не ставит на
 * него `<link rel="prefetch">` — Session Replay отсутствует в сборке целиком, а не «выключен
 * сэмплингом» (интеграция с нулевыми rate всё равно качала бы и исполняла ~35 КБ gz).
 */
export function buildReplayTemplate(enabled: boolean, sessionReplayModulePath: string): string {
  if (enabled) {
    return `export { loadSessionReplay } from ${JSON.stringify(sessionReplayModulePath)}\n`
  }
  return 'export async function loadSessionReplay() {}\n'
}
