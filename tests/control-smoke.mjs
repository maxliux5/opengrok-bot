import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const hostToken = (await readFile(".local/host.token", "utf8")).trim();
const runtimeToken = (await readFile(".local/desktop.env", "utf8")).trim().split("=", 2)[1];
const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
let controlId;
let desktopTouched = false;

async function host(path, method = "GET") {
  const response = await fetch(`http://127.0.0.1:3842${path}`, {
    method, headers: { authorization: `Bearer ${hostToken}` },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function snapshot() {
  return page.evaluate(() => {
    const canvas = document.querySelector("#vnc canvas");
    if (!canvas) throw new Error("VNC canvas missing");
    const context = canvas.getContext("2d");
    return [...context.getImageData(130, 105, 550, 55).data];
  });
}

async function pressKey() {
  await page.evaluate(() => {
    window.rfb.sendKey(0xffe3, "ControlLeft", true);
    window.rfb.sendKey(0x6c, "KeyL");
    window.rfb.sendKey(0xffe3, "ControlLeft", false);
    window.rfb.sendKey(0x61, "KeyA");
  });
  await page.waitForTimeout(500);
}

async function shell(command) {
  const response = await fetch("http://127.0.0.1:3843/operation", {
    method: "POST", headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "shell_exec", args: { command, timeoutMs: 5000 },
      deadline: Date.now() + 10000 }),
  });
  if (!response.ok) throw new Error(await response.text());
  const result = await response.json();
  if (result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || `Command failed: ${command}`);
  return result.stdout.trim();
}

async function sendRawRfb(bytes) {
  await page.evaluate(payload => {
    const socket = window.rfb._sock._websocket;
    if (socket.readyState !== WebSocket.OPEN) throw new Error("RFB socket is closed");
    socket.send(new Uint8Array(payload));
  }, bytes);
}

function changed(left, right) {
  let count = 0;
  for (let i = 0; i < left.length; i += 4) {
    if (Math.abs(left[i] - right[i]) + Math.abs(left[i + 1] - right[i + 1]) +
      Math.abs(left[i + 2] - right[i + 2]) > 50) count++;
  }
  return count;
}

async function settledSnapshot() {
  let previous = await snapshot();
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.waitForTimeout(250);
    const current = await snapshot();
    if (changed(previous, current) < 100) return current;
    previous = current;
  }
  throw new Error("Desktop image did not settle");
}

try {
  const initial = await fetch("http://127.0.0.1:3843/health", {
    headers: { authorization: `Bearer ${runtimeToken}` },
  }).then(response => response.json());
  if (!["about:blank", "https://example.com/", "https://httpbin.org/cookies",
    "https://httpbin.org/forms/post", "https://www.selenium.dev/selenium/web/web-form.html"].includes(initial.url)) {
    throw new Error(`Control smoke requires a safe test page; current URL: ${initial.url}`);
  }
  desktopTouched = true;
  await page.goto("http://127.0.0.1:5173/");
  await page.evaluate(async () => {
    const { default: RFB } = await import("/node_modules/.vite/deps/@novnc_novnc.js");
    const target = document.createElement("div");
    target.id = "vnc";
    target.style.cssText = "position:fixed;inset:0;background:#fff;z-index:9999";
    document.body.append(target);
    const rfb = new RFB(target, "ws://127.0.0.1:6080");
    rfb.scaleViewport = false;
    rfb.viewOnly = false;
    window.rfb = rfb;
    await new Promise((resolve, reject) => {
      rfb.addEventListener("connect", resolve, { once: true });
      setTimeout(() => reject(new Error("VNC timeout")), 10000);
    });
  });
  await page.waitForTimeout(600);
  await shell("xdotool mousemove 700 600 click 1; xdotool mousemove 100 100");
  await shell("printf 'clipboard-before-rfb' | xclip -selection clipboard >/dev/null 2>&1");
  const pointerBefore = await shell("xdotool getmouselocation --shell");
  const clipboardBefore = await shell("xclip -selection clipboard -o");
  await sendRawRfb([5, 0, 1, 44, 1, 44]);
  const clipboardPayload = new TextEncoder().encode("clipboard-from-rfb");
  await sendRawRfb([6, 0, 0, 0, 0, 0, 0, clipboardPayload.length, ...clipboardPayload]);
  await page.waitForTimeout(300);
  const pointerAfter = await shell("xdotool getmouselocation --shell");
  const clipboardAfter = await shell("xclip -selection clipboard -o");
  const beforeReadOnly = await settledSnapshot();
  await pressKey();
  const afterReadOnly = await snapshot();
  const readOnlyChange = changed(beforeReadOnly, afterReadOnly);
  const granted = await host("/control", "POST");
  controlId = granted.controlId;
  await page.waitForTimeout(300);
  const beforeHuman = await settledSnapshot();
  await pressKey();
  const afterHuman = await snapshot();
  const humanChange = changed(beforeHuman, afterHuman);
  await page.screenshot({ path: ".local/control-smoke.png" });
  const runtime = await fetch("http://127.0.0.1:3843/health", {
    headers: { authorization: `Bearer ${runtimeToken}` },
  }).then(response => response.json());
  await sendRawRfb([5, 0, 1, 104, 1, 104]);
  const humanClipboardPayload = new TextEncoder().encode("clipboard-from-human-rfb");
  await sendRawRfb([6, 0, 0, 0, 0, 0, 0, humanClipboardPayload.length, ...humanClipboardPayload]);
  await page.waitForTimeout(300);
  await host(`/control/${controlId}`, "DELETE");
  controlId = undefined;
  const humanPointerAfter = await shell("xdotool getmouselocation --shell");
  const humanClipboardAfter = await shell("xclip -selection clipboard -o");
  console.log(JSON.stringify({ pointerBefore, pointerAfter, clipboardBefore, clipboardAfter,
    humanPointerAfter, humanClipboardAfter, readOnlyChange, humanChange, mode: runtime.mode }));
  if (pointerBefore !== pointerAfter || clipboardBefore !== clipboardAfter ||
    !humanPointerAfter.includes("X=360\nY=360") ||
    humanClipboardAfter !== "clipboard-from-human-rfb" ||
    readOnlyChange > 300 || humanChange < 300 || runtime.mode !== "human") process.exitCode = 1;
} finally {
  if (controlId) await host(`/control/${controlId}`, "DELETE");
  if (desktopTouched) {
    try { await shell("printf '' | xclip -selection clipboard >/dev/null 2>&1; xdotool mousemove 700 600 click 1"); }
    catch { /* Best-effort cleanup after a failed control test. */ }
  }
  await browser.close();
}
