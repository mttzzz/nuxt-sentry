const LOCAL_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
export function shouldEnableServerSentry(env) {
  if (env.nodeEnv !== "production") {
    return false;
  }
  return env.sentryDisabled !== "1";
}
export function shouldEnableClientSentry(opts) {
  if (!opts.isProd) {
    return false;
  }
  if (opts.excludeLocalhost && LOCAL_HOSTS.has(opts.hostname)) {
    return false;
  }
  return true;
}
