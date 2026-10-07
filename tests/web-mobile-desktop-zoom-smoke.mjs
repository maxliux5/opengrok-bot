import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const origin = "https://127.0.0.1:8444/";
const dataDir = ".local/https-desktop-20261006";
const username = process.env.OPENGROK_WEB_SMOKE_USERNAME || "https-e2e";
const password = process.env.OPENGROK_WEB_SMOKE_PASSWORD;
assert.ok(password, "OPENGROK_WEB_SMOKE_PASSWORD is required");
const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });

async function runtimeUrl() {
  const token = (await readFile(`${dataDir}/desktop.env`, "utf8")).trim().split("=", 2)[1];
  const response = await fetch("http://127.0.0.1:3845/health", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok);
  return (await response.json()).url;
}

async function returnControl() {
  const token = (await readFile(`${dataDir}/host.token`, "utf8")).trim();
  const state = await fetch("http://127.0.0.1:3844/state", {
    headers: { authorization: `Bearer ${token}` },
  }).then(response => response.json());
  const controlId = state.computer?.controlId;
  if (state.computer?.controlMode === "human" && controlId) {
    await fetch(`http://127.0.0.1:3844/control/${controlId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}` },
    });
  }
}

async function measure(canvas) {
  return canvas.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const data = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
    const colors = new Set();
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
      const offset = (Math.floor(y * element.height / 12) * element.width +
        Math.floor(x * element.width / 12)) * 4;
      colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`);
    }
    return { width: rect.width, height: rect.height, x: rect.x, y: rect.y,
      remoteWidth: element.width, remoteHeight: element.height, colors: colors.size };
  });
}

try {
  for (const width of [390, 320]) {
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true,
      viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const pageErrors = [];
    const sockets = [];
    try {
      const login = await context.request.post("/api/login", {
        data: { username, password },
      });
      assert.ok(login.ok(), await login.text());
      const page = await context.newPage();
      page.on("pageerror", error => pageErrors.push(error.message));
      page.on("websocket", socket => sockets.push(socket.url()));
      await page.goto("/");
      await page.getByRole("button", { name: "工作区" }).click();
      await page.getByRole("tab", { name: "电脑" }).click();
      await page.getByText("电脑已连接").waitFor({ timeout: 15_000 });
      const canvas = page.locator(".novnc-target canvas");
      await canvas.waitFor({ state: "visible", timeout: 15_000 });
      const fit = await measure(canvas);
      assert.equal(`${fit.remoteWidth}x${fit.remoteHeight}`, "1440x900");
      assert.ok(fit.colors > 1, "desktop frame is blank");
      await page.screenshot({ path: `.local/https-desktop-20261006/zoom-${width}-fit.png` });
      const socketsBeforeZoom = sockets.length;
      await page.getByTitle("原尺寸查看，可拖动画面").click();
      await page.getByTitle("适应窗口").waitFor();
      const native = await measure(canvas);
      await page.screenshot({ path: `.local/https-desktop-20261006/zoom-${width}-native.png` });
      assert.ok(fit.remoteWidth > fit.width * 2,
        `fit display was not scaled down: ${fit.remoteWidth} -> ${fit.width}`);
      assert.ok(Math.abs(native.remoteWidth - native.width) <= 2,
        `native pixels do not match screen pixels: ${native.remoteWidth} -> ${native.width}`);
      assert.ok(native.colors > 1, "native desktop frame is blank");
      assert.equal(sockets.length, socketsBeforeZoom, "zoom opened a second desktop socket");
      const beforePan = await canvas.evaluate(element => element.toDataURL());
      const stage = await page.locator(".desktop-stage").boundingBox();
      assert.ok(stage);
      for (const [start, end] of [[0.6, 0.25], [0.8, 0.2]]) {
        await page.mouse.move(stage.x + stage.width * start, stage.y + stage.height * 0.5);
        await page.mouse.down();
        await page.mouse.move(stage.x + stage.width * end, stage.y + stage.height * 0.5,
          { steps: 10 });
        await page.mouse.up();
      }
      await page.screenshot({ path: `.local/https-desktop-20261006/zoom-${width}-panned.png` });
      const afterPan = await canvas.evaluate(element => element.toDataURL());
      assert.notEqual(afterPan, beforePan, "drag did not pan the clipped desktop");
      await page.getByTitle("适应窗口").click();
      await page.getByTitle("原尺寸查看，可拖动画面").waitFor();
      const fitAgain = await measure(canvas);
      assert.ok(Math.abs(fitAgain.width - fit.width) <= 2,
        `fit mode did not restore width: ${fit.width} -> ${fitAgain.width}`);
      assert.equal(sockets.length, socketsBeforeZoom, "viewport change reconnected desktop");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `mobile page overflows by ${overflow}px`);
      let remoteInput = null;
      if (width === 390) {
        await page.getByTitle("原尺寸查看，可拖动画面").click();
        const socketsBeforeTakeover = sockets.length;
        await page.getByRole("button", { name: "接管电脑" }).click();
        await page.getByRole("button", { name: "归还控制" }).waitFor({ timeout: 15_000 });
        for (let attempt = 0; attempt < 50 && sockets.length <= socketsBeforeTakeover; attempt++) {
          await page.waitForTimeout(100);
        }
        assert.ok(sockets.length > socketsBeforeTakeover, "human mode did not open a new desktop socket");
        await page.getByText("电脑已连接").waitFor({ timeout: 15_000 });
        await page.waitForTimeout(300);
        const humanFrame = await measure(canvas);
        assert.ok(Math.abs(humanFrame.remoteWidth - humanFrame.width) <= 2,
          "human takeover lost native-size viewport");
        await page.touchscreen.tap(humanFrame.x + 250, humanFrame.y + 90);
        await page.waitForTimeout(200);
        await page.screenshot({ path: `.local/https-desktop-20261006/zoom-${width}-human-focused.png` });
        await page.keyboard.type("https://www.saucedemo.com/", { delay: 10 });
        await page.waitForTimeout(500);
        await page.getByTitle("发送回车").click();
        for (let attempt = 0; attempt < 30; attempt++) {
          remoteInput = await runtimeUrl();
          if (remoteInput?.startsWith("https://www.saucedemo.com/")) break;
          await page.waitForTimeout(200);
        }
        await page.screenshot({ path: `.local/https-desktop-20261006/zoom-${width}-human-input.png` });
        assert.ok(remoteInput?.startsWith("https://www.saucedemo.com/"),
          `native-size desktop did not deliver human input; sockets=${sockets.length}; ` +
          `status=${await page.locator(".desktop-status").innerText()}; ` +
          `error=${await page.locator(".desktop-pane .inline-error").allTextContents()}; ` +
          `remoteUrl=${remoteInput}`);
        await page.getByRole("button", { name: "归还控制" }).click();
        await page.getByRole("button", { name: "接管电脑" }).waitFor({ timeout: 15_000 });
      }
      assert.deepEqual(pageErrors, []);
      console.log(JSON.stringify({ viewport: width, remote: `${fit.remoteWidth}x${fit.remoteHeight}`,
        fitWidth: fit.width, nativePixels: `${native.remoteWidth}x${native.remoteHeight}`,
        restoredWidth: fitAgain.width,
        colors: fit.colors, desktopSockets: sockets.length, overflow, remoteInput }));
    } finally {
      await returnControl();
      await context.close();
    }
  }
} finally { await browser.close(); }
