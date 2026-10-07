import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "/opt/opengrok/node_modules/playwright/index.mjs";
import { installNetworkPolicy } from "/opt/opengrok/network-policy.mjs";

let requests = 0;
let upgrades = 0;
const server = createServer((request, response) => {
  requests += 1;
  if (request.url === "/sw.js") {
    response.writeHead(200, { "content-type": "application/javascript" });
    response.end("self.addEventListener('fetch', () => {});");
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<html>browser policy probe</html>");
});
server.on("upgrade", (_request, socket) => {
  upgrades += 1;
  socket.destroy();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true });

try {
  const guarded = await browser.newContext({ serviceWorkers: "block" });
  await installNetworkPolicy(guarded);
  const page = await guarded.newPage();
  const socketOutcome = await page.evaluate(port => new Promise(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/private`);
    socket.onopen = () => resolve("open");
    socket.onclose = event => resolve(`close:${event.code}`);
    socket.onerror = () => resolve("error");
    setTimeout(() => resolve("timeout"), 3000);
  }), port);
  await assert.rejects(page.goto(`http://127.0.0.1:${port}/private`, { timeout: 3000 }));
  assert.equal(socketOutcome, "close:1008");
  assert.equal(requests, 0);
  assert.equal(upgrades, 0);
  await guarded.close();

  const results = {};
  for (const policy of ["allow", "block"]) {
    const context = await browser.newContext({ serviceWorkers: policy });
    const workerPage = await context.newPage();
    await workerPage.goto(`http://127.0.0.1:${port}/`);
    await workerPage.evaluate(async () => {
      try { await navigator.serviceWorker.register("/sw.js"); } catch { /* blocked by policy */ }
    });
    for (let attempt = 0; attempt < 30; attempt++) {
      const active = await workerPage.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).some(registration => Boolean(registration.active)));
      if (active || policy === "block") break;
      await delay(100);
    }
    results[policy] = {
      active: await workerPage.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).some(registration => Boolean(registration.active))),
      workers: context.serviceWorkers().length,
    };
    await context.close();
  }
  assert.equal(results.allow.active, true);
  assert.equal(results.allow.workers, 1);
  assert.equal(results.block.active, false);
  assert.equal(results.block.workers, 0);
  console.log(JSON.stringify({ socketOutcome, privateHttpRequests: 0,
    privateWebSocketUpgrades: upgrades, serviceWorkers: results }));
} finally {
  await browser.close();
  server.close();
}
