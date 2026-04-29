import * as Sentry from "@sentry/bun";
import { defineNitroPlugin } from "nitropack/runtime";
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("request", (event) => {
    const user = event.context.user;
    if (user?.id) {
      Sentry.setUser({
        id: user.id,
        email: user.email,
        username: user.name ?? void 0
      });
    }
  });
  nitroApp.hooks.hook("afterResponse", () => {
    Sentry.setUser(null);
  });
});
