/*
 * Из Sentry DSN построить URL для tunnel envelope-форварда.
 *
 * DSN: `https://<key>@<host>/<projectId>`
 * Tunnel ingest: `https://<host>/api/<projectId>/envelope/`
 *
 * Парсим стандартным `URL` — `username` берёт <key>, `host` — host, `pathname` — /<projectId>.
 * Бросает Error если DSN кривой (нет projectId или host) — это лучше тихого 500 в проде.
 */

export function buildTunnelIngestUrl(dsn: string): string {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    throw new Error(`[nuxt-sentry] Invalid DSN format: ${dsn}`)
  }

  const projectId = url.pathname.replace(/^\/+/u, '').replace(/\/+$/u, '')
  if (!projectId) {
    throw new Error(`[nuxt-sentry] DSN has no project id: ${dsn}`)
  }
  if (!url.host) {
    throw new Error(`[nuxt-sentry] DSN has no host: ${dsn}`)
  }

  return `${url.protocol}//${url.host}/api/${projectId}/envelope/`
}
