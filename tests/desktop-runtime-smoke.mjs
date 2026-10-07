import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

const token = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];

async function operation(name, args = {}) {
  const response = await fetch("http://127.0.0.1:3843/operation", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args, controlEpoch: 1, operationId: crypto.randomUUID(),
      deadline: Date.now() + 60_000 }),
    signal: AbortSignal.timeout(65_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${name}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

await operation("browser_open", { url: "https://www.selenium.dev/selenium/web/web-form.html" });
for (let attempt = 0; attempt < 20; attempt++) {
  const page = await operation("browser_read").catch(() => null);
  if (page?.text?.includes("Text input")) break;
  await new Promise(resolve => setTimeout(resolve, 250));
  if (attempt === 19) throw new Error("Public test form did not render");
}
const snapshot = await operation("desktop_observe");
const png = Buffer.from(snapshot.imageBase64, "base64");
assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
assert.equal(snapshot.width, 1440);
assert.equal(snapshot.height, 900);
assert.ok(png.length > 10_000);
writeFileSync(".local/desktop-observe.png", png);
const click = await operation("desktop_click", { observationId: snapshot.observationId,
  x: 250, y: 221, button: "left" });
assert.equal(click.action, "click_sent");
await assert.rejects(operation("desktop_click", { observationId: snapshot.observationId,
  x: 250, y: 221, button: "left" }), /observation expired/);
const focused = await operation("desktop_observe");
const pasted = await operation("desktop_type", { observationId: focused.observationId,
  text: "桌面输入-123" });
assert.equal(pasted.action, "paste_sent");
let page = await operation("browser_read");
assert.equal(page.elements.find(item => item.label.includes("Text input"))?.value, "桌面输入-123");
const beforeKey = await operation("desktop_observe");
const key = await operation("desktop_key", { observationId: beforeKey.observationId, key: "Ctrl+A" });
assert.equal(key.action, "key_sent");
const afterKey = await operation("desktop_observe");
writeFileSync(".local/desktop-after-key.png", Buffer.from(afterKey.imageBase64, "base64"));
await operation("desktop_type", { observationId: afterKey.observationId, text: "Final-123" });
await new Promise(resolve => setTimeout(resolve, 400));
const afterPaste = await operation("desktop_observe");
writeFileSync(".local/desktop-after-paste.png", Buffer.from(afterPaste.imageBase64, "base64"));
page = await operation("browser_read");
assert.equal(page.elements.find(item => item.label.includes("Text input"))?.value, "Final-123");
console.log(JSON.stringify({ observationId: snapshot.observationId, width: snapshot.width,
  height: snapshot.height, bytes: png.length, screenshot: ".local/desktop-observe.png",
  click: click.action, staleRejected: true, pasted: pasted.action, key: key.action,
  finalValue: "Final-123" }));
