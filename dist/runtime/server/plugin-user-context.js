import * as Sentry from "@sentry/bun";
import { getRequestIP } from "h3";
import { defineNitroPlugin } from "nitropack/runtime";
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("request", (event) => {
    const user = event.context.user;
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? void 0;
    if (user?.id) {
      Sentry.setUser({
        id: user.id,
        email: user.email,
        username: user.name ?? void 0,
        ip_address: ip
      });
    } else if (ip) {
      Sentry.setUser({ ip_address: ip });
    }
  });
  nitroApp.hooks.hook("afterResponse", () => {
    Sentry.setUser(null);
  });
});
