import { publicUrl } from "./public-url.mjs";

export { publicUrl } from "./public-url.mjs";

export async function installNetworkPolicy(context) {
  await context.route("**/*", async route => {
    if (await publicUrl(route.request().url())) await route.continue();
    else await route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", async socket => {
    if (await publicUrl(socket.url(), ["ws:", "wss:"])) socket.connectToServer();
    else await socket.close({ code: 1008, reason: "Public WebSocket URLs only" });
  });
}
