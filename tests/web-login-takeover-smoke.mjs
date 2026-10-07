import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const origin = new URL(process.env.OPENGROK_WEB_SMOKE_ORIGIN || "http://127.0.0.1:5174");
const dataDir = process.env.OPENGROK_WEB_SMOKE_DATA_DIR || ".local";
const runtimeUrl = process.env.OPENGROK_WEB_SMOKE_RUNTIME_URL || "http://127.0.0.1:3843";
const hostUrl = process.env.OPENGROK_WEB_SMOKE_HOST_URL || "http://127.0.0.1:3842";
const username = process.env.OPENGROK_WEB_SMOKE_USERNAME || "smoke";
const password = process.env.OPENGROK_WEB_SMOKE_PASSWORD;
assert.ok(password, "OPENGROK_WEB_SMOKE_PASSWORD is required");
const screenshotPrefix = process.env.OPENGROK_WEB_SMOKE_SCREENSHOT_PREFIX || ".local/web-login";
const https = origin.protocol === "https:";
assert.equal(origin.hostname, "127.0.0.1");
assert.ok(origin.href === "http://127.0.0.1:5174/" || origin.href === "https://127.0.0.1:8444/");
assert.match(runtimeUrl, /^http:\/\/127\.0\.0\.1:384[35]$/);
assert.match(hostUrl, /^http:\/\/127\.0\.0\.1:384[24]$/);
if (https) {
  assert.notEqual(dataDir, ".local", "HTTPS 验收必须使用独立测试数据目录");
  assert.equal(runtimeUrl, "http://127.0.0.1:3845");
  assert.equal(hostUrl, "http://127.0.0.1:3844");
}
const runtimeToken = (await readFile(join(dataDir, "desktop.env"), "utf8")).trim().split("=", 2)[1];
const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ baseURL: origin.href, ignoreHTTPSErrors: https,
  viewport: { width: 1480, height: 1000 } });
const page = await context.newPage();
const sockets = [];
const socketEvents = [];
const pageErrors = [];
page.on("websocket", socket => {
  sockets.push(socket.url());
  socketEvents.push(`open:${socket.url()}`);
  socket.on("close", () => socketEvents.push(`close:${socket.url()}`));
  socket.on("socketerror", error => socketEvents.push(`error:${socket.url()}:${error}`));
});
page.on("pageerror", error => pageErrors.push(error.message));

async function runtime(path, body) {
  const response = await fetch(`${runtimeUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${runtimeToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

async function host(path, method = "GET") {
  const hostToken = (await readFile(join(dataDir, "host.token"), "utf8")).trim();
  const response = await fetch(`${hostUrl}${path}`, {
    method, headers: { authorization: `Bearer ${hostToken}` },
  });
  return { status: response.status, data: await response.json() };
}

try {
  const initial = await runtime("/health");
  assert.equal(initial.data.url, "https://www.saucedemo.com/");
  const login = await context.request.post("/api/login", {
    data: { username, password },
  });
  assert.equal(login.ok(), true, await login.text());
  const sessionCookie = (await context.cookies(origin.href)).find(item => item.name === "opengrok_session");
  assert.ok(sessionCookie);
  if (https) {
    assert.equal(sessionCookie.secure, true);
    assert.equal(sessionCookie.httpOnly, true);
    assert.equal(sessionCookie.sameSite, "Lax");
  }
  await page.goto("/");
  await page.getByTitle("展开电脑").click();
  await page.getByText("电脑已连接").waitFor({ timeout: 15_000 });
  assert.ok(sockets.some(url => url === `${https ? "wss" : "ws"}://${origin.host}/desktop`));
  await page.getByRole("button", { name: "接管电脑" }).click();
  await page.getByRole("button", { name: "归还控制" }).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  const blocked = await runtime("/operation", {
    name: "browser_read", args: {}, deadline: Date.now() + 10_000,
  });
  assert.equal(blocked.status, 409);

  const canvas = page.locator(".novnc-target canvas");
  try { await canvas.waitFor({ state: "visible", timeout: 15_000 }); }
  catch (cause) {
    await page.screenshot({ path: `${screenshotPrefix}-failure.png` });
    console.error(JSON.stringify({ desktopStatus: await page.locator(".desktop-status").allTextContents(),
      desktopError: await page.locator(".desktop-pane .inline-error").allTextContents(),
      canvasCount: await canvas.count(), sockets, socketEvents, pageErrors }));
    throw cause;
  }
  const frame = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const pixels = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
    const colors = new Set();
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
      const offset = (Math.floor(y * element.height / 12) * element.width +
        Math.floor(x * element.width / 12)) * 4;
      colors.add(`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}`);
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      remoteWidth: element.width, remoteHeight: element.height, sampledColors: colors.size };
  });
  assert.ok(frame.width > 500 && frame.height > 400);
  assert.ok(frame.sampledColors > 1, "HTTPS 桌面画面只有一种颜色");
  await page.screenshot({ path: `${screenshotPrefix}-before.png` });
  await page.mouse.click(frame.x + 680 * frame.width / frame.remoteWidth,
    frame.y + 300 * frame.height / frame.remoteHeight);
  await page.waitForTimeout(200);
  await page.keyboard.type("standard_user", { delay: 20 });
  await page.keyboard.press("Tab");
  await page.keyboard.type("secret_sauce", { delay: 20 });
  await page.keyboard.press("Enter");
  let url = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    await page.waitForTimeout(500);
    url = (await runtime("/health")).data.url;
    if (url.endsWith("/inventory.html")) break;
  }
  await page.screenshot({ path: `${screenshotPrefix}-after.png` });
  assert.equal(url, "https://www.saucedemo.com/inventory.html");
  await page.getByRole("button", { name: "归还控制" }).click();
  await page.getByRole("button", { name: "接管电脑" }).waitFor({ timeout: 15_000 });
  const read = await runtime("/operation", {
    name: "browser_read", args: {}, deadline: Date.now() + 20_000,
  });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.match(read.data.text, /Sauce Labs Backpack/);
  let unauthDesktopClose = null;
  let mobileCanvas = null;
  let mobileOverflow = null;
  if (https) {
    const anonymous = await browser.newContext({ baseURL: origin.href, ignoreHTTPSErrors: true });
    try {
      const anonymousPage = await anonymous.newPage();
      await anonymousPage.goto("/");
      unauthDesktopClose = await anonymousPage.evaluate(() => new Promise(resolve => {
        const socket = new WebSocket(`wss://${location.host}/desktop`);
        const timeout = setTimeout(() => { socket.close(); resolve(0); }, 5000);
        socket.onclose = event => { clearTimeout(timeout); resolve(event.code); };
      }));
      assert.equal(unauthDesktopClose, 1008, "未登录的桌面 WebSocket 未被拒绝");
    } finally { await anonymous.close(); }

    const mobile = await browser.newContext({ baseURL: origin.href, ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mobileLogin = await mobile.request.post("/api/login", { data: { username, password } });
      assert.equal(mobileLogin.ok(), true, await mobileLogin.text());
      const mobilePage = await mobile.newPage();
      await mobilePage.goto("/");
      await mobilePage.getByRole("button", { name: "工作区" }).click();
      await mobilePage.getByRole("tab", { name: "电脑" }).click();
      await mobilePage.getByText("电脑已连接").waitFor({ timeout: 15_000 });
      const mobileScreen = mobilePage.locator(".novnc-target canvas");
      await mobileScreen.waitFor({ state: "visible", timeout: 15_000 });
      mobileCanvas = await mobileScreen.evaluate(element => `${element.width}x${element.height}`);
      mobileOverflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(mobileOverflow <= 0, `手机页面横向溢出 ${mobileOverflow}px`);
      await mobilePage.screenshot({ path: `${screenshotPrefix}-mobile.png` });
    } finally { await mobile.close(); }
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ webControl: true, login: true, returned: true,
    https, secureCookie: sessionCookie.secure, desktopSocket: sockets.find(url => url.endsWith("/desktop")),
    url: read.data.url, frame: `${frame.remoteWidth}x${frame.remoteHeight}`,
    sampledColors: frame.sampledColors, unauthDesktopClose, mobileCanvas, mobileOverflow }));
} finally {
  const state = await host("/state").catch(() => null);
  if (state?.data?.computer?.controlMode === "human" && state.data.computer.controlId) {
    await host(`/control/${state.data.computer.controlId}`, "DELETE").catch(() => undefined);
  }
  await context.close();
  await browser.close();
}
