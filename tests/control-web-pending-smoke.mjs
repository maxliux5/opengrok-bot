import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const runtimeToken = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];
const hostToken = readFileSync(".local/host.token", "utf8").trim();
const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
const errors = [];

async function runtime(name, args = {}) {
  const response = await fetch("http://127.0.0.1:3843/operation", {
    method: "POST", headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args, deadline: Date.now() + 20_000 }),
  });
  return { status: response.status, result: await response.json() };
}

async function login(page) {
  await page.goto("http://127.0.0.1:5174/");
  await page.getByLabel("用户名").fill("smoke");
  await page.getByLabel("密码").fill(testPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await page.locator(".app-shell").waitFor();
}

async function hostState() {
  const response = await fetch("http://127.0.0.1:3844/state", {
    headers: { authorization: `Bearer ${hostToken}` },
  });
  if (!response.ok) throw new Error(`Host state: ${response.status}`);
  return (await response.json()).computer;
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", error => errors.push(error.message));
  await login(page);
  await page.getByRole("tab", { name: "电脑" }).click();
  await page.getByText("电脑已连接").waitFor({ timeout: 15_000 });
  const opened = await runtime("browser_open", { url: "https://www.selenium.dev/selenium/web/web-form.html" });
  assert.equal(opened.status, 200);
  const observed = await runtime("browser_read");
  assert.equal(observed.status, 200);
  const textField = observed.result.elements.find(item => item.label.includes("Text input"));
  assert.ok(textField);
  const operation = fetch("http://127.0.0.1:3843/operation", {
    method: "POST", headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "shell_exec", args: { command: "sleep 6", timeoutMs: 10_000 },
      deadline: Date.now() + 15_000 }),
  });
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "接管电脑" }).click();
  await page.getByText("控制权交接中").first().waitFor({ timeout: 10_000 });
  await page.screenshot({ path: ".local/control-pending-web-desktop.png" });
  const operationResult = await operation;
  assert.equal(operationResult.status, 200);
  await page.getByRole("button", { name: "归还控制" }).waitFor({ timeout: 20_000 });
  await page.getByText("你正在操作电脑").waitFor();
  const blockedScreenshot = await runtime("browser_screenshot");
  assert.equal(blockedScreenshot.status, 409);
  await page.getByRole("button", { name: "归还控制" }).click();
  await page.getByText("观察模式").waitFor({ timeout: 10_000 });
  const staleInput = await runtime("browser_fill", {
    observationId: observed.result.observationId, ref: textField.ref, value: "stale observation",
  });
  assert.equal(staleInput.status, 409);
  const refreshed = await runtime("browser_read");
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.result.observationId, observed.result.observationId);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  mobile.on("pageerror", error => errors.push(error.message));
  await login(mobile);
  await mobile.getByRole("button", { name: "工作区" }).click();
  await mobile.getByRole("tab", { name: "电脑" }).click();
  await mobile.getByText("电脑已连接").waitFor({ timeout: 15_000 });
  await mobile.screenshot({ path: ".local/control-pending-web-mobile.png" });
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const canvas = await mobile.locator(".novnc-target canvas").evaluate(element => ({
    width: element.width, height: element.height,
  }));
  console.log(JSON.stringify({ desktopOverflow, mobileOverflow, canvas, errors,
    screenshotDuringHuman: blockedScreenshot.status, staleInputAfterReturn: staleInput.status,
    finalMode: (await hostState()).controlMode }));
  assert.equal(desktopOverflow, false);
  assert.equal(mobileOverflow, false);
  assert.ok(canvas.width > 0 && canvas.height > 0);
  assert.deepEqual(errors, []);
  assert.equal((await hostState()).controlMode, "agent");
} finally {
  const current = await hostState().catch(() => null);
  if (current?.controlMode === "human" && current.controlId) {
    await fetch(`http://127.0.0.1:3844/control/${current.controlId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${hostToken}` },
    });
  }
  await browser.close();
}
