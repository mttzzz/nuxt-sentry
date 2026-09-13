import * as Sentry from "@sentry/vue";
export async function loadSessionReplay() {
  const client = Sentry.getClient();
  if (!client || client.getOptions().enabled === false) {
    return;
  }
  try {
    const { replayIntegration } = await import("@sentry/replay");
    client.addIntegration(
      replayIntegration({
        blockAllMedia: false,
        maskAllInputs: false,
        maskAllText: false,
        networkDetailAllowUrls: [globalThis.location.origin]
      })
    );
  } catch (error) {
    Sentry.addBreadcrumb({
      category: "replay",
      level: "warning",
      message: `session replay chunk failed: ${String(error)}`
    });
  }
}
