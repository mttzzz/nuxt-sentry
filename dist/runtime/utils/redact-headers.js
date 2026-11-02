export const FILTERED_VALUE = "[Filtered]";
const SENSITIVE_HEADER_SNIPPETS = [
  "auth",
  "token",
  "secret",
  "session",
  "password",
  "passwd",
  "pwd",
  "key",
  "jwt",
  "bearer",
  "sso",
  "saml",
  "csrf",
  "xsrf",
  "credentials",
  "sid",
  "identity",
  "set-cookie",
  "cookie"
];
export function isSensitiveHeaderName(name) {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_SNIPPETS.some((snippet) => lower.includes(snippet));
}
export function redactHeaders(headers) {
  const redacted = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = value !== void 0 && isSensitiveHeaderName(name) ? FILTERED_VALUE : value;
  }
  return redacted;
}
