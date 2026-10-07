import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

if (process.env.OPENGROK_ALLOW_DESKTOP_RESTART_TEST !== "1") {
  throw new Error("Set OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1 before rebuilding the desktop");
}

const hostToken = (await readFile(".local/host.token", "utf8")).trim();
const runtimeToken = (await readFile(".local/desktop.env", "utf8")).trim().split("=", 2)[1];
const inventoryUrl = "https://www.saucedemo.com/inventory.html";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function host(path, method = "GET") {
  const response = await fetch(`http://127.0.0.1:3842${path}`, {
    method, headers: { authorization: `Bearer ${hostToken}` },
  });
  const data = await response.json();
  assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function runtime(name) {
  const response = await fetch("http://127.0.0.1:3843/operation", {
    method: "POST", headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args: name === "browser_open" ? { url: inventoryUrl } : {},
      deadline: Date.now() + 50_000 }),
  });
  const data = await response.json();
  assert.equal(response.ok, true, `${name}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

const before = (await host("/state")).computer;
assert.equal(before.status, "ready");
assert.equal(before.controlMode, "agent");
assert.ok(before.sessionId);
const beforeRead = await runtime("browser_read");
assert.equal(beforeRead.url, inventoryUrl);
assert.match(beforeRead.text, /Sauce Labs Backpack/);

await host("/restart", "POST");
let after;
for (let attempt = 0; attempt < 120; attempt++) {
  await wait(1000);
  after = (await host("/state")).computer;
  if (after.status === "ready" && after.controlMode === "agent" && after.sessionId !== before.sessionId) break;
}
assert.ok(after);
assert.equal(after.status, "ready");
assert.equal(after.controlMode, "agent");
assert.notEqual(after.sessionId, before.sessionId);
assert.ok(after.generation > before.generation);
const reopened = await runtime("browser_open");
assert.equal(reopened.url, inventoryUrl);
const afterRead = await runtime("browser_read");
assert.match(afterRead.text, /Products/);
assert.match(afterRead.text, /Sauce Labs Backpack/);
console.log(JSON.stringify({ sessionChanged: true, generationBefore: before.generation,
  generationAfter: after.generation, loginPersisted: true, url: afterRead.url }));
