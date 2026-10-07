import { createServer, request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import { pathToFileURL } from "node:url";
import { resolvePublicUrl } from "../../packages/network-policy/public-url.mjs";

function upstreamConfig(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" ||
    url.search || url.hash) throw new Error("Invalid upstream proxy URL");
  return { host: url.hostname, port: Number(url.port || 80) };
}

function chosenAddress(addresses) {
  return addresses.find(entry => entry.family === 4)?.address || addresses[0].address;
}

function authority(address, port) {
  return `${address.includes(":") ? `[${address}]` : address}:${port}`;
}

function allowedPort(url) {
  const port = Number(url.port || (url.protocol === "http:" || url.protocol === "ws:" ? 80 : 443));
  return port === (url.protocol === "http:" || url.protocol === "ws:" ? 80 : 443);
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port });
    socket.setTimeout(10_000);
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("timeout", () => socket.destroy(new Error("Connection timed out")));
    socket.once("error", reject);
  });
}

function readHeaders(socket) {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Upstream proxy timed out")), 10_000);
    function finish(error, result) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(result);
    }
    function onError(error) { finish(error); }
    function onClose() { finish(new Error("Upstream proxy closed")); }
    function onData(chunk) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 8192) return finish(new Error("Upstream proxy headers too large"));
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.pause();
      const status = pending.subarray(0, end).toString("latin1").split("\r\n", 1)[0];
      finish(null, { status, remainder: pending.subarray(end + 4) });
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function connectHttps(address, port, upstream) {
  if (!upstream) return { socket: await connect(address, port), remainder: Buffer.alloc(0) };
  const socket = await connect(upstream.host, upstream.port);
  try {
    const target = authority(address, port);
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    const reply = await readHeaders(socket);
    if (!/^HTTP\/1\.[01] 200\b/.test(reply.status)) throw new Error(reply.status);
    return { socket, remainder: reply.remainder };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function socketError(socket, status) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function bridge(client, target) {
  const onIdle = () => { client.destroy(); target.destroy(); };
  client.setTimeout(15 * 60_000, onIdle);
  target.setTimeout(15 * 60_000, onIdle);
  client.on("error", () => target.destroy());
  target.on("error", () => client.destroy());
  client.on("close", () => target.destroy());
  target.on("close", () => client.destroy());
  client.pipe(target);
  target.pipe(client);
  target.resume();
}

export function createEgressGateway(options = {}) {
  const upstream = upstreamConfig(options.upstreamProxy);
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      const target = await resolvePublicUrl(request.url, ["http:"]);
      if (!target || !allowedPort(target.url)) {
        response.writeHead(403).end();
        return;
      }
      const address = chosenAddress(target.addresses);
      const headers = { ...request.headers, host: target.url.host };
      for (const name of ["proxy-authorization", "proxy-connection", "connection", "upgrade"]) {
        delete headers[name];
      }
      const outgoing = httpRequest({ hostname: address, family: target.addresses.find(item =>
        item.address === address).family, port: Number(target.url.port || 80), method: request.method,
      path: `${target.url.pathname}${target.url.search}`, headers, timeout: 30_000 }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      outgoing.on("timeout", () => outgoing.destroy(new Error("Origin timed out")));
      outgoing.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on("aborted", () => outgoing.destroy());
      response.on("close", () => outgoing.destroy());
      request.pipe(outgoing);
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });

  server.on("connect", async (request, client, head) => {
    if (client.destroyed) return;
    let parsed;
    try { parsed = new URL(`proxy://${request.url}`); } catch { socketError(client, "403 Forbidden"); return; }
    if (!parsed.port || (parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
      socketError(client, "403 Forbidden");
      return;
    }
    const target = await resolvePublicUrl(parsed.href, ["proxy:"]);
    if (!target || Number(parsed.port) !== 443) { socketError(client, "403 Forbidden"); return; }
    try {
      const { socket, remainder } = await connectHttps(chosenAddress(target.addresses), Number(parsed.port), upstream);
      if (client.destroyed) { socket.destroy(); return; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (remainder.length) client.write(remainder);
      if (head.length) socket.write(head);
      bridge(client, socket);
    } catch {
      socketError(client, "502 Bad Gateway");
    }
  });

  server.on("upgrade", async (request, client, head) => {
    if (client.destroyed) return;
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socketError(client, "403 Forbidden");
      return;
    }
    const target = await resolvePublicUrl(request.url, ["http:", "ws:"]);
    if (!target || !allowedPort(target.url)) { socketError(client, "403 Forbidden"); return; }
    try {
      const socket = await connect(chosenAddress(target.addresses), Number(target.url.port || 80));
      if (client.destroyed) { socket.destroy(); return; }
      const headers = { ...request.headers, host: target.url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      socket.write(`GET ${target.url.pathname}${target.url.search} HTTP/1.1\r\n`);
      for (const [name, value] of Object.entries(headers)) socket.write(`${name}: ${value}\r\n`);
      socket.write("\r\n");
      if (head.length) socket.write(head);
      bridge(client, socket);
    } catch {
      socketError(client, "502 Bad Gateway");
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.OPENGROK_EGRESS_LISTEN_HOST || "127.0.0.1";
  const port = Number(process.env.OPENGROK_EGRESS_PORT || 3888);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid egress port");
  const server = createEgressGateway({ upstreamProxy: process.env.OPENGROK_EGRESS_UPSTREAM_PROXY });
  server.listen(port, host, () => console.log(JSON.stringify({ event: "egress_gateway_ready", host, port })));
}
