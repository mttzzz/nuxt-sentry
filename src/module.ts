import { addPlugin, addServerHandler, addServerPlugin, addTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { defu } from 'defu'

import type { ModuleOptions, PublicRuntimeSentryConfig, ResolvedModuleOptions } from './runtime/types'
import { buildTunnelIngestUrl } from './runtime/utils/tunnel-ingest-url'

export type { ModuleOptions } from './runtime/types'

const DEFAULTS = {
  org: 'pushka-biz',
  tunnelEndpoint: '/api/sentry-tunnel',
  tracesSampleRate: 0.5,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,
  tracePropagationTargets: [/^\/api\//] as (string | RegExp)[],
  additionalIgnorePatterns: [] as (string | RegExp)[],
  ignoredRoutes: [
    '/api/sentry-tunnel',
    '/_nuxt',
    '/api/ws',
    '/api/health',
    '/__nuxt_error',
  ],
  excludeLocalhostInProd: true,
}

/*
 * Сериализация значения в JS-литерал для build-time inline в `nitro.replace` /
 * `vite.define`. JSON.stringify теряет RegExp, поэтому собираем литералы вручную:
 *   string  → "..."
 *   RegExp  → /pattern/flags
 *   number/boolean → стандарт
 *   array   → [el1, el2, ...]
 */
function serializeBuildLiteral(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(serializeBuildLiteral).join(',')}]`
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

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@mttzzz/nuxt-sentry',
    configKey: 'sentry',
    compatibility: { nuxt: '^4.0.0' },
  },
  defaults: {} as ModuleOptions,
  setup(opts, nuxt) {
    /*
     * `nuxt-module-build prepare` подгружает модуль без user-options, чтобы
     * сгенерить тайпинги. В этом режиме validation срабатывать не должна —
     * иначе prepare крашится. На реальный build/dev/test консьюмера всегда
     * приходят options через nuxt.config.ts → `sentry: {...}`.
     */
    if (nuxt.options._prepare) {
      return
    }
    if (!opts.dsn) {
      throw new Error('[nuxt-sentry] `sentry.dsn` is required.')
    }
    if (!opts.project) {
      throw new Error('[nuxt-sentry] `sentry.project` is required.')
    }
    if (!opts.cachePrefix) {
      throw new Error('[nuxt-sentry] `sentry.cachePrefix` is required.')
    }

    const resolved: ResolvedModuleOptions = {
      dsn: opts.dsn,
      project: opts.project,
      cachePrefix: opts.cachePrefix,
      org: opts.org ?? DEFAULTS.org,
      tunnelEndpoint: opts.tunnelEndpoint ?? DEFAULTS.tunnelEndpoint,
      tracesSampleRate: opts.tracesSampleRate ?? DEFAULTS.tracesSampleRate,
      replaysSessionSampleRate: opts.replaysSessionSampleRate ?? DEFAULTS.replaysSessionSampleRate,
      replaysOnErrorSampleRate: opts.replaysOnErrorSampleRate ?? DEFAULTS.replaysOnErrorSampleRate,
      tracePropagationTargets: opts.tracePropagationTargets ?? DEFAULTS.tracePropagationTargets,
      additionalIgnorePatterns: opts.additionalIgnorePatterns ?? DEFAULTS.additionalIgnorePatterns,
      ignoredRoutes: opts.ignoredRoutes ?? DEFAULTS.ignoredRoutes,
      excludeLocalhostInProd: opts.excludeLocalhostInProd ?? DEFAULTS.excludeLocalhostInProd,
    }

    const resolver = createResolver(import.meta.url)
    const tunnelIngestUrl = buildTunnelIngestUrl(resolved.dsn)

    /* runtimeConfig.public.sentry — сериализуемая часть (без RegExp). */
    const publicConfig: PublicRuntimeSentryConfig = {
      dsn: resolved.dsn,
      project: resolved.project,
      cachePrefix: resolved.cachePrefix,
      org: resolved.org,
      tunnelEndpoint: resolved.tunnelEndpoint,
      tracesSampleRate: resolved.tracesSampleRate,
      replaysSessionSampleRate: resolved.replaysSessionSampleRate,
      replaysOnErrorSampleRate: resolved.replaysOnErrorSampleRate,
      ignoredRoutes: resolved.ignoredRoutes,
      excludeLocalhostInProd: resolved.excludeLocalhostInProd,
    }
    nuxt.options.runtimeConfig.public.sentry = defu(
      nuxt.options.runtimeConfig.public.sentry as object | undefined,
      publicConfig,
    ) as PublicRuntimeSentryConfig

    /*
     * Build-time значения (DSN, cachePrefix, tunnelIngestUrl, tracePropagationTargets с RegExp'ами,
     * additionalIgnorePatterns) пишем в виртуальный модуль через `addTemplate`. Vite `define` /
     * Nitro `replace` не поддерживают array-literals (и тем более RegExp), а runtimeConfig
     * не сериализует RegExp. Темплейт компилится в `.nuxt/nuxt-sentry-build-config.mjs`,
     * импортируется как `#build/nuxt-sentry-build-config` из server и client рантаймов.
     */
    const buildConfigTpl = addTemplate({
      filename: 'nuxt-sentry-build-config.mjs',
      write: true,
      getContents: () =>
        [
          `export const dsn = ${serializeBuildLiteral(resolved.dsn)}`,
          `export const project = ${serializeBuildLiteral(resolved.project)}`,
          `export const cachePrefix = ${serializeBuildLiteral(resolved.cachePrefix)}`,
          `export const tunnelIngestUrl = ${serializeBuildLiteral(tunnelIngestUrl)}`,
          `export const tracesSampleRate = ${serializeBuildLiteral(resolved.tracesSampleRate)}`,
          `export const ignoredRoutes = ${serializeBuildLiteral(resolved.ignoredRoutes)}`,
          `export const tracePropagationTargets = ${serializeBuildLiteral(resolved.tracePropagationTargets)}`,
          `export const additionalIgnorePatterns = ${serializeBuildLiteral(resolved.additionalIgnorePatterns)}`,
          '',
        ].join('\n'),
    })

    /*
     * Регистрируем alias `#nuxt-sentry/config` для VITE и для NITRO. Без этого `#build/...`
     * блокируется impound-plugin'ом в server runtime; а просто `~/.nuxt/...` не переживёт
     * стабкомпиляции на стороне консьюмера. Через alias путь к dst-файлу подставляется
     * корректно для обоих рантаймов.
     */
    nuxt.options.alias = nuxt.options.alias || {}
    nuxt.options.alias['#nuxt-sentry/config'] = buildConfigTpl.dst

    nuxt.options.nitro = nuxt.options.nitro || {}
    nuxt.options.nitro.alias = nuxt.options.nitro.alias || {}
    nuxt.options.nitro.alias['#nuxt-sentry/config'] = buildConfigTpl.dst

    /*
     * tunnel-route — добавляем в `routeRules: { [tunnelEndpoint]: { cors: true } }` —
     * чтобы стейл-deploy-guard / nginx не перехватывали POST. Подстраховка: cors,
     * чтобы любые клиенты (Cordova/native webview) могли проксировать.
     */
    nuxt.options.routeRules = defu(nuxt.options.routeRules, {
      [resolved.tunnelEndpoint]: { cors: true },
    } as Record<string, unknown>) as typeof nuxt.options.routeRules

    /*
     * Server plugins (порядок важен: capture-errors сначала, чтобы хук был зарегистрирован
     * раньше любого throw из других плагинов).
     */
    addServerPlugin(resolver.resolve('./runtime/server/plugin-capture-errors'))
    addServerPlugin(resolver.resolve('./runtime/server/plugin-user-context'))

    /* Tunnel handler */
    addServerHandler({
      route: resolved.tunnelEndpoint,
      method: 'post',
      handler: resolver.resolve('./runtime/server/tunnel.post'),
    })

    /* Client plugin */
    addPlugin({
      src: resolver.resolve('./runtime/plugin.client'),
      mode: 'client',
    })

    /*
     * vite plugin для sourcemap upload в Sentry — только в production-build
     * и при наличии SENTRY_AUTH_TOKEN. Без токена плагин в no-op, но мы лучше
     * не подключаем чтобы лишний раз не шуметь варнингами.
     */
    if (process.env.NODE_ENV === 'production' && process.env.SENTRY_AUTH_TOKEN) {
      nuxt.options.vite.plugins = nuxt.options.vite.plugins || []
      const plugins = Array.isArray(nuxt.options.vite.plugins) ? nuxt.options.vite.plugins : [nuxt.options.vite.plugins]
      plugins.push(
        sentryVitePlugin({
          org: resolved.org,
          project: resolved.project,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          silent: true,
          telemetry: false,
          sourcemaps: {
            filesToDeleteAfterUpload: ['.output/**/public/**/*.map'],
          },
        }),
      )
      nuxt.options.vite.plugins = plugins
    }

    /*
     * `nitro:config` hook — инжектит instrument.server в Nitro server entry как
     * top-level rollup chunk. Sentry init выполняется ДО любых application-imports,
     * чтобы Prisma/OTEL успели обернуться. Только в production: в dev OTEL шумит
     * и Sentry всё равно отключён через NODE_ENV-гейт.
     */
    nuxt.hook('nitro:config', (nitroConfig) => {
      if (process.env.NODE_ENV !== 'production') return

      const instrumentPath = resolver.resolve('./runtime/instrument.server')

      nitroConfig.rollupConfig ||= {}
      nitroConfig.rollupConfig.plugins ||= []

      const plugins = Array.isArray(nitroConfig.rollupConfig.plugins)
        ? nitroConfig.rollupConfig.plugins
        : [nitroConfig.rollupConfig.plugins]

      plugins.push({
        name: '@mttzzz/nuxt-sentry:instrument-injection',
        buildStart() {
          this.emitFile({
            type: 'chunk',
            id: instrumentPath,
            fileName: 'instrument.server.mjs',
          })
        },
        renderChunk(code: string, chunk: { isEntry?: boolean }) {
          if (!chunk.isEntry) return null
          return { code: `import './instrument.server.mjs';\n${code}`, map: null }
        },
      })

      nitroConfig.rollupConfig.plugins = plugins
    })
  },
})

declare module 'nuxt/schema' {
  interface PublicRuntimeConfig {
    sentry?: PublicRuntimeSentryConfig
  }
}
