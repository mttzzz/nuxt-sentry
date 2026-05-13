import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { defineNuxtModule, createResolver, addServerImports, addTemplate, addServerPlugin, addServerHandler, addPlugin } from '@nuxt/kit';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { defu } from 'defu';
import { buildTunnelIngestUrl } from '../dist/runtime/utils/tunnel-ingest-url.js';

const DEFAULTS = {
  org: "pushka-biz",
  tunnelEndpoint: "/api/sentry-tunnel",
  tracesSampleRate: 0.1,
  queueTracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 0.1,
  tracePropagationTargets: [/^\/api\//u],
  additionalIgnorePatterns: [],
  ignoredRoutes: ["/api/sentry-tunnel", "/_nuxt", "/api/ws", "/api/health", "/__nuxt_error"],
  excludeLocalhostInProd: true
};
function resolveSourcePath(userPath, rootDir, srcDir) {
  let absolute;
  if (userPath.startsWith("~~/")) {
    absolute = resolve(rootDir, userPath.slice(3));
  } else if (userPath.startsWith("~/") || userPath.startsWith("@/")) {
    absolute = resolve(srcDir, userPath.slice(2));
  } else if (isAbsolute(userPath)) {
    absolute = userPath;
  } else {
    absolute = resolve(rootDir, userPath);
  }
  for (const ext of ["", ".ts", ".mts", ".js", ".mjs"]) {
    if (existsSync(absolute + ext)) {
      return absolute;
    }
  }
  return null;
}
function buildVirtualReexport(absoluteSourcePath, fallback) {
  if (absoluteSourcePath) {
    return `export { default } from ${JSON.stringify(absoluteSourcePath)}
`;
  }
  return `export default ${fallback}
`;
}
function serializeBuildLiteral(value) {
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeBuildLiteral(v)).join(",")}]`;
  }
  if (value instanceof RegExp) {
    return value.toString();
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === null || value === void 0) {
    return "undefined";
  }
  return JSON.stringify(value);
}
const module$1 = defineNuxtModule({
  meta: {
    name: "@mttzzz/nuxt-sentry",
    configKey: "sentry",
    compatibility: { nuxt: "^4.0.0" }
  },
  defaults: {},
  setup(opts, nuxt) {
    const resolver = createResolver(import.meta.url);
    addServerImports([
      {
        name: "instrumentPostgresJs",
        from: resolver.resolve("./runtime/utils/instrument-postgres-js")
      },
      {
        name: "createLogger",
        from: resolver.resolve("./runtime/utils/logger")
      },
      {
        name: "createLoggerWithSink",
        from: resolver.resolve("./runtime/utils/logger")
      },
      {
        name: "withCronMonitor",
        from: resolver.resolve("./runtime/utils/sentry-cron")
      },
      {
        name: "defineSentryTask",
        from: resolver.resolve("./runtime/utils/define-sentry-task")
      }
    ]);
    if (nuxt.options._prepare) {
      return;
    }
    if (!opts.dsn) {
      throw new Error("[nuxt-sentry] `sentry.dsn` is required.");
    }
    if (!opts.project) {
      throw new Error("[nuxt-sentry] `sentry.project` is required.");
    }
    if (!opts.cachePrefix) {
      throw new Error("[nuxt-sentry] `sentry.cachePrefix` is required.");
    }
    const resolved = {
      dsn: opts.dsn,
      project: opts.project,
      cachePrefix: opts.cachePrefix,
      org: opts.org ?? DEFAULTS.org,
      tunnelEndpoint: opts.tunnelEndpoint ?? DEFAULTS.tunnelEndpoint,
      tracesSampleRate: opts.tracesSampleRate ?? DEFAULTS.tracesSampleRate,
      queueTracesSampleRate: opts.queueTracesSampleRate ?? DEFAULTS.queueTracesSampleRate,
      replaysSessionSampleRate: opts.replaysSessionSampleRate ?? DEFAULTS.replaysSessionSampleRate,
      replaysOnErrorSampleRate: opts.replaysOnErrorSampleRate ?? DEFAULTS.replaysOnErrorSampleRate,
      tracePropagationTargets: opts.tracePropagationTargets ?? DEFAULTS.tracePropagationTargets,
      additionalIgnorePatterns: opts.additionalIgnorePatterns ?? DEFAULTS.additionalIgnorePatterns,
      ignoredRoutes: opts.ignoredRoutes ?? DEFAULTS.ignoredRoutes,
      excludeLocalhostInProd: opts.excludeLocalhostInProd ?? DEFAULTS.excludeLocalhostInProd
    };
    const tunnelIngestUrl = buildTunnelIngestUrl(resolved.dsn);
    const publicConfig = {
      dsn: resolved.dsn,
      project: resolved.project,
      cachePrefix: resolved.cachePrefix,
      org: resolved.org,
      tunnelEndpoint: resolved.tunnelEndpoint,
      tracesSampleRate: resolved.tracesSampleRate,
      queueTracesSampleRate: resolved.queueTracesSampleRate,
      replaysSessionSampleRate: resolved.replaysSessionSampleRate,
      replaysOnErrorSampleRate: resolved.replaysOnErrorSampleRate,
      ignoredRoutes: resolved.ignoredRoutes,
      excludeLocalhostInProd: resolved.excludeLocalhostInProd
    };
    nuxt.options.runtimeConfig.public.sentry = defu(
      nuxt.options.runtimeConfig.public.sentry,
      publicConfig
    );
    const buildConfigTpl = addTemplate({
      filename: "nuxt-sentry-build-config.mjs",
      write: true,
      getContents: () => [
        `export const dsn = ${serializeBuildLiteral(resolved.dsn)}`,
        `export const project = ${serializeBuildLiteral(resolved.project)}`,
        `export const cachePrefix = ${serializeBuildLiteral(resolved.cachePrefix)}`,
        `export const tunnelIngestUrl = ${serializeBuildLiteral(tunnelIngestUrl)}`,
        `export const tracesSampleRate = ${serializeBuildLiteral(resolved.tracesSampleRate)}`,
        `export const ignoredRoutes = ${serializeBuildLiteral(resolved.ignoredRoutes)}`,
        `export const tracePropagationTargets = ${serializeBuildLiteral(resolved.tracePropagationTargets)}`,
        `export const additionalIgnorePatterns = ${serializeBuildLiteral(resolved.additionalIgnorePatterns)}`,
        ""
      ].join("\n")
    });
    function resolvePathOptionOrThrow(optionName, userPath) {
      if (!userPath) {
        return null;
      }
      const resolvedAbs = resolveSourcePath(userPath, nuxt.options.rootDir, nuxt.options.srcDir);
      if (!resolvedAbs) {
        throw new Error(
          `[nuxt-sentry] sentry.${optionName} = ${JSON.stringify(userPath)}: file not found.
Hint: in Nuxt 4 \`~/\` points to \`app/\` (Vue side), \`~~/\` to project root.
Server-side files (e.g. server/utils/error-filter.ts) need \`~~/server/...\`.`
        );
      }
      return resolvedAbs;
    }
    const errorFilterPath = resolvePathOptionOrThrow("errorReportFilter", opts.errorReportFilter);
    const errorEnricherPath = resolvePathOptionOrThrow("errorReportEnricher", opts.errorReportEnricher);
    const errorFilterTpl = addTemplate({
      filename: "nuxt-sentry-error-filter.mjs",
      write: true,
      getContents: () => buildVirtualReexport(errorFilterPath, "() => true")
    });
    const errorEnricherTpl = addTemplate({
      filename: "nuxt-sentry-error-enricher.mjs",
      write: true,
      getContents: () => buildVirtualReexport(errorEnricherPath, "() => ({})")
    });
    nuxt.options.alias ??= {};
    nuxt.options.alias["#nuxt-sentry/config"] = buildConfigTpl.dst;
    nuxt.options.alias["#nuxt-sentry/error-filter"] = errorFilterTpl.dst;
    nuxt.options.alias["#nuxt-sentry/error-enricher"] = errorEnricherTpl.dst;
    nuxt.options.nitro ??= {};
    nuxt.options.nitro.alias ??= {};
    nuxt.options.nitro.alias["#nuxt-sentry/config"] = buildConfigTpl.dst;
    nuxt.options.nitro.alias["#nuxt-sentry/error-filter"] = errorFilterTpl.dst;
    nuxt.options.nitro.alias["#nuxt-sentry/error-enricher"] = errorEnricherTpl.dst;
    nuxt.options.routeRules = defu(nuxt.options.routeRules, {
      [resolved.tunnelEndpoint]: { cors: true }
    });
    addServerPlugin(resolver.resolve("./runtime/server/plugin-capture-errors"));
    addServerPlugin(resolver.resolve("./runtime/server/plugin-user-context"));
    addServerHandler({
      route: resolved.tunnelEndpoint,
      method: "post",
      handler: resolver.resolve("./runtime/server/tunnel.post")
    });
    addPlugin({
      src: resolver.resolve("./runtime/plugin.client"),
      mode: "client"
    });
    if (process.env.NODE_ENV === "production" && process.env.SENTRY_AUTH_TOKEN) {
      nuxt.options.vite.plugins ??= [];
      const plugins = Array.isArray(nuxt.options.vite.plugins) ? nuxt.options.vite.plugins : [nuxt.options.vite.plugins];
      plugins.push(
        sentryVitePlugin({
          org: resolved.org,
          project: resolved.project,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          silent: true,
          telemetry: false,
          sourcemaps: {
            filesToDeleteAfterUpload: [".output/**/public/**/*.map"]
          }
        })
      );
      nuxt.options.vite.plugins = plugins;
    }
    nuxt.hook("nitro:config", (nitroConfig) => {
      if (process.env.NODE_ENV !== "production") {
        return;
      }
      const instrumentPath = resolver.resolve("./runtime/instrument.server");
      nitroConfig.rollupConfig ??= {};
      nitroConfig.rollupConfig.plugins ??= [];
      const plugins = Array.isArray(nitroConfig.rollupConfig.plugins) ? nitroConfig.rollupConfig.plugins : [nitroConfig.rollupConfig.plugins];
      const instrumentReplacements = {
        __NUXT_SENTRY_DSN__: serializeBuildLiteral(resolved.dsn),
        __NUXT_SENTRY_CACHE_PREFIX__: serializeBuildLiteral(resolved.cachePrefix),
        __NUXT_SENTRY_TRACES_SAMPLE_RATE__: serializeBuildLiteral(resolved.tracesSampleRate),
        __NUXT_SENTRY_QUEUE_TRACES_SAMPLE_RATE__: serializeBuildLiteral(resolved.queueTracesSampleRate),
        __NUXT_SENTRY_IGNORED_ROUTES__: serializeBuildLiteral(resolved.ignoredRoutes)
      };
      plugins.push({
        name: "@mttzzz/nuxt-sentry:instrument-injection",
        buildStart() {
          this.emitFile({
            type: "chunk",
            id: instrumentPath,
            fileName: "instrument.server.mjs"
          });
        },
        renderChunk(code, chunk) {
          if (chunk.fileName === "instrument.server.mjs") {
            let replaced = code;
            for (const [token, value] of Object.entries(instrumentReplacements)) {
              replaced = replaced.replaceAll(token, value);
            }
            return { code: replaced, map: null };
          }
          if (!chunk.isEntry) {
            return null;
          }
          return { code: `import './instrument.server.mjs';
${code}`, map: null };
        }
      });
      nitroConfig.rollupConfig.plugins = plugins;
    });
  }
});

export { module$1 as default };
