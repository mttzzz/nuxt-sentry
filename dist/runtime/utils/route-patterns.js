const REST_SUFFIX = "/**";
const REGEXP_SPECIAL = /[$()*+.?[\\\]^{|}]/gu;
export function routePatternToRegExpSource(pattern) {
  const withRest = pattern.endsWith(REST_SUFFIX);
  const prefix = withRest ? pattern.slice(0, -REST_SUFFIX.length) : pattern;
  const body = prefix.split("/").map((segment) => {
    if (segment === "*") {
      return "[^/]+";
    }
    if (segment.includes("*")) {
      throw new Error(
        `[nuxt-sentry] sentry.client.disabledRoutes: unsupported pattern ${JSON.stringify(pattern)}. \`*\` and \`**\` are allowed only as a whole path segment, and \`**\` only as the last one (\`/prefix/**\`).`
      );
    }
    return segment.replaceAll(REGEXP_SPECIAL, String.raw`\$&`);
  }).join("/");
  return `^${body}${withRest ? String.raw`(?:/[\s\S]*)?` : ""}$`;
}
export function createRouteMatcher(patterns) {
  const regexps = patterns.map((pattern) => new RegExp(routePatternToRegExpSource(pattern)));
  return (pathname) => regexps.some((regexp) => regexp.test(pathname));
}
