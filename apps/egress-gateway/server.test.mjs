import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { createEgressGateway } from "./server.mjs";

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    }).once("error", reject).end();
  });
}

function tunnel(port, target, message) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method: "CONNECT", path: target });
    outgoing.once("connect", (response, socket) => {
      if (!message || response.statusCode !== 200) {
        socket.destroy();
        resolve({ status: response.statusCode });
        return;
      }
      socket.once("data", chunk => {
        socket.destroy();
        resolve({ status: response.statusCode, text: chunk.toString() });
      });
      socket.once("error", reject);
      socket.write(message);
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

test("gateway pins public CONNECT to an IP and refuses private targets", async () => {
  const targets = [];
  const upstream = createServer();
  upstream.on("connect", (request, socket) => {
    targets.push(request.url);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", chunk => socket.write(chunk));
    socket.on("end", () => socket.end());
  });
  const upstreamPort = await listen(upstream);
  const gateway = createEgressGateway({ upstreamProxy: `http://127.0.0.1:${upstreamPort}` });
  const gatewayPort = await listen(gateway);
  try {
    assert.equal(await get(gatewayPort, "/health"), 200);
    assert.equal(await get(gatewayPort, "http://127.0.0.1:45998/"), 403);
    assert.equal(await get(gatewayPort, "http://1.1.1.1:8080/"), 403);
    assert.deepEqual(await tunnel(gatewayPort, "127.0.0.1:443"), { status: 403 });
    assert.deepEqual(await tunnel(gatewayPort, "1.1.1.1:8443"), { status: 403 });
    assert.deepEqual(await tunnel(gatewayPort, "1.1.1.1:443", "ping"),
      { status: 200, text: "ping" });
    assert.deepEqual(targets, ["1.1.1.1:443"]);
  } finally {
    await close(gateway);
    await close(upstream);
  }
});
