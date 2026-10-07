import assert from "node:assert/strict";
import { chromium } from "playwright";

const password = process.env.OPENGROK_TEST_PASSWORD;
assert.ok(password, "OPENGROK_TEST_PASSWORD is required");
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined });
const context = await browser.newContext({ ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const name = `界面例程 ${Date.now()}`;

try {
  await page.goto("https://127.0.0.1:8444/", { waitUntil: "networkidle" });
  await page.getByLabel("用户名").fill("routine-smoke");
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: /工作区/ }).click();
  await page.getByRole("tab", { name: "例程" }).click();
  await page.getByRole("button", { name: "新建例程" }).click();
  const editor = page.getByRole("dialog", { name: "新建例程" });
  await editor.getByLabel("名称").fill(name);
  await editor.getByLabel("每天").fill("08:45");
  await editor.getByLabel("时区").fill("Asia/Shanghai");
  await editor.getByLabel("输入来源").fill("每天核对今日清单并回复摘要。");
  await editor.getByLabel("模型步骤").fill("2");
  await editor.getByRole("button", { name: "保存例程" }).click();
  const row = page.locator(".routine-row").filter({ hasText: name });
  await row.waitFor();
  await row.getByRole("button", { name: "试跑一次" }).click();
  await page.getByRole("button", { name: /工作区/ }).click();
  await page.getByRole("tab", { name: "例程" }).click();
  if (!await page.locator(".routine-occurrence").first().isVisible()) {
    await row.getByRole("button", { name: /界面例程/ }).click();
  }
  await page.locator(".routine-occurrence").first().waitFor();
  await row.getByRole("button", { name: "暂停例程" }).click();
  await row.getByText("已暂停").waitFor();
  await row.getByRole("button", { name: "恢复例程" }).click();
  await row.getByText(/下次/).waitFor();
  await page.screenshot({ path: ".local/routine-web-mobile.png" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: ".local/routine-web-desktop.png" });
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(desktopOverflow, false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ name, history: await page.locator(".routine-occurrence").count(),
    mobileOverflow: overflow, desktopOverflow, pageErrors: errors }));
} finally { await browser.close(); }
