/*
 * Паттерны путей для `client.disabledRoutes`: документы, на которых клиентский Sentry не работает вовсе.
 *
 * Синтаксис — подмножество routeRules Nitro, только целыми сегментами пути:
 *   - `/clients`      — ровно этот путь;
 *   - `*`             — один непустой сегмент: `/clients/*` совпадает с `/clients/abc`, но не с `/clients`,
 *                       не с `/clients/` и не с `/clients/a/b`;
 *   - `/**` в конце   — этот префикс и всё, что под ним: `/clients/**` совпадает с `/clients`, `/clients/`,
 *                       `/clients/abc` и `/clients/a/b`, но не с `/clientsx`.
 * Остальное — литералы: `.`, `+`, `(`, `[` и прочие знаки регулярок экранируются. `*` и `**` внутри сегмента
 * (`/a*`) и `**` не в конце пути не поддерживаются: паттерн, написанный «как glob», молча совпал бы не с тем, что
 * имел в виду автор, поэтому разбор бросает ошибку — при setup модуля, а не в браузере покупателя.
 *
 * Сверка — с `location.pathname` как есть: регистр значим, query и hash в пути нет, завершающий слеш не
 * нормализуется, символы вне ASCII — в закодированном браузером виде (`/%D0%BA…`).
 *
 * Паттерн превращается в ИСТОЧНИК RegExp без флагов и без ES2015+-конструкций. Один и тот же текст исполняют
 * оба потребителя: клиентский плагин (createRouteMatcher) и ES5-скрипт раннего beacon'а (`new RegExp(source)`
 * в его inline-тексте, источники вшиваются при сборке) — расхождения семантики между ними быть не может.
 * RegExp через runtimeConfig не сериализуется, поэтому наружу выходят именно строки.
 */

const REST_SUFFIX = '/**'

/* Знаки RegExp, которые в паттерне — обычные символы пути: экранируются обратной косой (`\$&` — найденный знак). */
const REGEXP_SPECIAL = /[$()*+.?[\\\]^{|}]/gu

/* Паттерн → источник RegExp (без флагов). Бросает на неподдерживаемом синтаксисе `*` / `**`. */
export function routePatternToRegExpSource(pattern: string): string {
  const withRest = pattern.endsWith(REST_SUFFIX)
  const prefix = withRest ? pattern.slice(0, -REST_SUFFIX.length) : pattern
  const body = prefix
    .split('/')
    .map((segment) => {
      if (segment === '*') {
        return '[^/]+'
      }
      if (segment.includes('*')) {
        throw new Error(
          `[nuxt-sentry] sentry.client.disabledRoutes: unsupported pattern ${JSON.stringify(pattern)}. ` +
            '`*` and `**` are allowed only as a whole path segment, and `**` only as the last one (`/prefix/**`).',
        )
      }
      return segment.replaceAll(REGEXP_SPECIAL, String.raw`\$&`)
    })
    .join('/')
  /* `[\s\S]`, а не `.`: точка не берёт переводы строк, а `*` (`[^/]`) берёт — «всё ниже» не должно зависеть от символа. */
  return `^${body}${withRest ? String.raw`(?:/[\s\S]*)?` : ''}$`
}

/* Список паттернов → предикат над `location.pathname`: совпал хотя бы один. Пустой список не совпадает ни с чем. */
export function createRouteMatcher(patterns: readonly string[]): (pathname: string) => boolean {
  // oxlint-disable-next-line require-unicode-regexp -- без флагов: ровно так источник исполняет ES5-скрипт beacon'а (там `u` недоступен)
  const regexps = patterns.map((pattern) => new RegExp(routePatternToRegExpSource(pattern)))
  return (pathname) => regexps.some((regexp) => regexp.test(pathname))
}
