import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const hostToken = (await readFile(".local/host.token", "utf8")).trim();
const runtimeToken = (await readFile(".local/desktop.env", "utf8")).trim().split("=", 2)[1];
const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
let controlId;

async function host(path, method = "GET") {
  const response = await fetch(`http://127.0.0.1:3842${path}`, {
    method, headers: { authorization: `Bearer ${hostToken}` },
  });
  const result = await response.json();
  assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

async function runtime(path, body) {
  const response = await fetch(`http://127.0.0.1:3843${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${runtimeToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

try {
  const initial = await host("/state");
  assert.equal(initial.computer.status, "ready");
  assert.equal(initial.computer.controlMode, "agent");
  const current = await runtime("/health");
  assert.equal(current.data.url, "https://www.saucedemo.com/");
  await page.goto("http://127.0.0.1:5173/");
  await page.evaluate(async () => {
    const { default: RFB } = await import("/node_modules/.vite/deps/@novnc_novnc.js");
    const target = document.createElement("div");
    target.id = "login-vnc";
    target.style.cssText = "position:fixed;inset:0;background:#fff;z-index:9999";
    document.body.append(target);
    const rfb = new RFB(target, "ws://127.0.0.1:6080");
    rfb.scaleViewport = false;
    rfb.viewOnly = false;
    window.loginRfb = rfb;
    await new Promise((resolve, reject) => {
      rfb.addEventListener("connect", resolve, { once: true });
      setTimeout(() => reject(new Error("VNC connection timed out")), 10000);
    });
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: ".local/login-takeover-before.png" });
  if (process.env.OPENGROK_LOGIN_OBSERVE === "1") {
    console.log(JSON.stringify({ ready: true, url: current.data.url, screenshot: ".local/login-takeover-before.png" }));
  } else {
    const granted = await host("/control", "POST");
    controlId = granted.controlId;
    assert.ok(controlId);
    const blocked = await runtime("/operation", {
      name: "browser_read", args: {}, deadline: Date.now() + 10_000,
    });
    assert.equal(blocked.status, 409);
    await page.evaluate(() => {
      const rfb = window.loginRfb;
      const socket = rfb._sock._websocket;
      const click = (x, y) => {
        const position = [x >> 8, x & 255, y >> 8, y & 255];
        socket.send(new Uint8Array([5, 1, ...position]));
        socket.send(new Uint8Array([5, 0, ...position]));
      };
      click(680, 300);
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: ".local/login-takeover-focused.png" });
    await page.evaluate(() => {
      const rfb = window.loginRfb;
      for (const character of "standard_user") rfb.sendKey(character.codePointAt(0));
      rfb.sendKey(0xff09);
      for (const character of "secret_sauce") rfb.sendKey(character.codePointAt(0));
      rfb.sendKey(0xff0d);
    });
    let observedUrl = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      await page.waitForTimeout(500);
      observedUrl = (await runtime("/health")).data.url;
      if (observedUrl.endsWith("/inventory.html")) break;
    }
    await page.screenshot({ path: ".local/login-takeover-after.png" });
    assert.equal(observedUrl, "https://www.saucedemo.com/inventory.html");
    await host(`/control/${controlId}`, "DELETE");
    controlId = undefined;
    const read = await runtime("/operation", {
      name: "browser_read", args: {}, deadline: Date.now() + 20_000,
    });
    assert.equal(read.status, 200, JSON.stringify(read.data));
    assert.match(read.data.text, /Products/);
    assert.match(read.data.text, /Sauce Labs Backpack/);
    console.log(JSON.stringify({ controlReturned: true, url: read.data.url,
      inventoryVisible: true, generation: read.data.generation }));
  }
} finally {
  if (controlId) await host(`/control/${controlId}`, "DELETE").catch(() => undefined);
  await browser.close();
}
