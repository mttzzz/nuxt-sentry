import * as Sentry from '@sentry/vue'

/*
 * Session Replay — ПОСЛЕ init, динамическим импортом peer-пакета `@sentry/replay`: без ссылки на
 * replayIntegration в статическом коде пакет (sideEffects:false, ~35 КБ gz rrweb-рекордера)
 * выпадает из entry tree-shaking'ом и едет отдельным чанком с origin приложения — не с CDN Sentry
 * (внешние CDN у части пользователей BY/RU недоступны). `client.addIntegration` для пост-init
 * интеграции зовёт afterAllSetup, а replayIntegration читает replaysSessionSampleRate /
 * replaysOnErrorSampleRate из client.getOptions() в момент setup — сэмплирование не меняется.
 *
 * Этот модуль попадает в сборку ТОЛЬКО при `sentry.replay !== false`: плагин импортирует
 * `#nuxt-sentry/replay`, и module.ts подставляет туда либо реэкспорт отсюда, либо no-op
 * (тогда `import('@sentry/replay')` в бандле нет вовсе — ни чанка, ни prefetch-ссылки).
 */
export async function loadSessionReplay(): Promise<void> {
  const client = Sentry.getClient()
  /* Localhost/dev (shouldEnableClientSentry → false): чанк не грузится вовсе. */
  if (!client || client.getOptions().enabled === false) {
    return
  }
  try {
    const { replayIntegration } = await import('@sentry/replay')
    client.addIntegration(
      replayIntegration({
        blockAllMedia: false,
        maskAllInputs: false,
        maskAllText: false,
        networkDetailAllowUrls: [globalThis.location.origin],
      }),
    )
  } catch (error) {
    /* Сбой чанка (офлайн, окно выкатки) — breadcrumb, не console.warn: captureConsole сделал бы
       Issue из каждого сетевого блипа. */
    Sentry.addBreadcrumb({
      category: 'replay',
      level: 'warning',
      message: `session replay chunk failed: ${String(error)}`,
    })
  }
}
