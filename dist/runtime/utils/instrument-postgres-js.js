import { instrumentPostgresJsSql } from "@sentry/bun";
export function instrumentPostgresJs(sql, options) {
  return instrumentPostgresJsSql(sql, options);
}
