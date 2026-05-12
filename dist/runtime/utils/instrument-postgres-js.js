import { instrumentPostgresJsSql } from "@sentry/core";
export function instrumentPostgresJs(sql, options) {
  return instrumentPostgresJsSql(sql, options);
}
