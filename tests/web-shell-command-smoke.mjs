import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ baseURL: "http://127.0.0.1:5174",
  viewport: { width: 1280, height: 850 } });
const page = await context.newPage();

async function api(path, method = "GET", data) {
  const response = await context.request.fetch(`/api${path}`, { method, data });
  const result = await response.json();
  assert.equal(response.ok(), true, `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`);
  return result;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const bots = (await api("/bots")).bots;
  const bot = bots.find(item => item.name.startsWith("Shell stop "));
  assert.ok(bot);
  const conversation = (await api(`/bots/${bot.id}/conversations`)).conversations[0];
  assert.ok(conversation);
  const run = (await api(`/conversations/${conversation.id}/runs`)).runs[0];
  const command = (await api(`/runs/${run.id}/shell-commands`)).commands[0];
  assert.equal(command.command, "sleep 8");

  await page.goto("/");
  await page.locator(".bot-row").filter({ hasText: bot.name }).click();
  await page.locator(".conversation-row").filter({ hasText: "验证逐命令停止" }).click();
  await page.getByRole("tab", { name: "活动" }).click();
  const row = page.locator(".shell-command").filter({ hasText: "sleep 8" });
  await row.waitFor();
  assert.equal(await row.getByText("已停止").isVisible(), true);
  await row.getByText("查看回执").click();
  assert.equal(await row.getByText(/信号：SIGTERM/).isVisible(), true);
  await page.screenshot({ path: ".local/web-shell-command.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /工作区/ }).click();
  await page.waitForTimeout(250);
  assert.equal(await row.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: ".local/web-shell-command-mobile.png" });
  console.log(JSON.stringify({ runId: run.id, command: command.command,
    status: "已停止", receiptSignal: "SIGTERM", mobileOverflow: false }));
} finally {
  await context.close();
  await browser.close();
}
