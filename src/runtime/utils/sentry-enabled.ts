/*
 * Решения, включать ли Sentry для текущего процесса/сессии.
 *
 * Server (`shouldEnableServerSentry`):
 *   - NODE_ENV !== 'production' → off (dev / unit-тесты).
 *   - SENTRY_DISABLED === '1' → off (test-image обычно билдится с NODE_ENV=production
 *     через `Dockerfile target=production`, поэтому только NODE_ENV-чек не отличает
 *     прод от test-стака; явный SENTRY_DISABLED ставится в docker-compose.test.yml).
 *
 * Client (`shouldEnableClientSentry`):
 *   - !isProd → off.
 *   - excludeLocalhost && hostname в LOCAL_HOSTS → off.
 *
 * Чистые функции — позволяют тестировать без перезагрузки модуля
 * (которая ломается о Vitest-frozen process.env.NODE_ENV).
 */

const LOCAL_HOSTS = new Set<string>(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])

export function shouldEnableServerSentry(env: {
  nodeEnv: string | undefined
  sentryDisabled: string | undefined
}): boolean {
  if (env.nodeEnv !== 'production') {
    return false
  }
  return env.sentryDisabled !== '1'
}

export function shouldEnableClientSentry(opts: {
  isProd: boolean
  hostname: string
  excludeLocalhost: boolean
}): boolean {
  if (!opts.isProd) {
    return false
  }
  if (opts.excludeLocalhost && LOCAL_HOSTS.has(opts.hostname)) {
    return false
  }
  return true
}
