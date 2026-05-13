export function buildTunnelIngestUrl(dsn) {
  let url;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`[nuxt-sentry] Invalid DSN format: ${dsn}`);
  }
  const projectId = url.pathname.replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (!projectId) {
    throw new Error(`[nuxt-sentry] DSN has no project id: ${dsn}`);
  }
  if (!url.host) {
    throw new Error(`[nuxt-sentry] DSN has no host: ${dsn}`);
  }
  return `${url.protocol}//${url.host}/api/${projectId}/envelope/`;
}
