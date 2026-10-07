import assert from "node:assert/strict";
import { test } from "node:test";
import { installNetworkPolicy, publicUrl } from "./network-policy.mjs";

test("public URL policy rejects local and private destinations", async () => {
  for (const url of [
    "http://127.0.0.1/", "https://10.1.2.3/", "https://169.254.169.254/",
    "https://100.64.1.1/", "http://[::1]/", "https://[fc00::1]/",
    "https://[::ffff:127.0.0.1]/", "http://printer.local/",
    "https://service.internal/", "file:///etc/passwd", "https://user:pass@example.com/",
  ]) assert.equal(await publicUrl(url), false, url);
  assert.equal(await publicUrl("https://8.8.8.8/"), true);
  assert.equal(await publicUrl("https://[2606:4700:4700::1111]/"), true);
});

test("all resolved addresses must be public", async () => {
  const mixed = async () => [
    { address: "8.8.8.8", family: 4 }, { address: "192.168.1.5", family: 4 },
  ];
  const publicOnly = async () => [{ address: "1.1.1.1", family: 4 }];
  assert.equal(await publicUrl("https://example.com/", undefined, mixed), false);
  assert.equal(await publicUrl("https://example.com/", undefined, publicOnly), true);
  assert.equal(await publicUrl("https://example.com/", undefined, async () => {
    throw new Error("DNS unavailable");
  }), false);
  assert.equal(await publicUrl("wss://example.com/socket", ["ws:", "wss:"], publicOnly), true);
  assert.equal(await publicUrl("wss://example.com/socket", undefined, publicOnly), false);
});

test("HTTP and WebSocket routes reject private URLs before connecting", async () => {
  let httpHandler;
  let socketHandler;
  await installNetworkPolicy({
    async route(pattern, handler) {
      assert.equal(pattern, "**/*");
      httpHandler = handler;
    },
    async routeWebSocket(pattern, handler) {
      assert.equal(pattern, "**/*");
      socketHandler = handler;
    },
  });
  const events = [];
  const route = url => ({
    request: () => ({ url: () => url }),
    continue: async () => events.push("continued"),
    abort: async reason => events.push(`aborted:${reason}`),
  });
  const socket = url => ({
    url: () => url,
    connectToServer: () => events.push("connected"),
    close: async options => events.push(`closed:${options.code}`),
  });
  await httpHandler(route("https://8.8.8.8/"));
  await httpHandler(route("http://127.0.0.1/"));
  await socketHandler(socket("wss://1.1.1.1/socket"));
  await socketHandler(socket("ws://192.168.1.5/socket"));
  assert.deepEqual(events, ["continued", "aborted:blockedbyclient", "connected", "closed:1008"]);
});
