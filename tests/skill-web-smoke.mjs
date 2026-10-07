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
const name = `界面技能 ${Date.now()}`;

try {
  await page.goto("https://127.0.0.1:8444/", { waitUntil: "networkidle" });
  await page.getByLabel("用户名").fill("smoke");
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: /工作区/ }).click();
  await page.getByRole("tab", { name: "技能" }).click();
  await page.getByRole("button", { name: "新建技能" }).click();
  const editor = page.getByRole("dialog", { name: "新建技能" });
  await editor.getByLabel("名称").fill(name);
  await editor.getByLabel("说明").fill("界面版本记录验证");
  await editor.getByLabel("所需输入").fill("给出一个问题。");
  await editor.getByLabel("步骤 1").fill("读取任务输入。");
  await editor.getByLabel("结果核验").fill("回答包含核对结果。");
  await editor.getByRole("checkbox", { name: "长期记忆" }).check();
  await page.screenshot({ path: ".local/skill-editor-mobile.png" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await editor.getByRole("button", { name: "创建技能" }).click();
  const row = page.locator(".skill-row").filter({ hasText: name });
  await row.waitFor();
  await row.getByRole("checkbox", { name: "用于当前 Bot" }).check();
  await row.getByRole("button", { name: "编辑技能" }).click();
  const second = page.getByRole("dialog", { name: /编辑技能/ });
  await second.getByLabel("所需输入").fill("给出问题和背景。");
  await second.getByRole("button", { name: "保存新版本" }).click();
  await row.getByText("v2").waitFor();
  await row.getByRole("button", { name: "查看版本" }).click();
  const history = page.getByRole("dialog", { name: /版本记录/ });
  await history.waitFor();
  assert.equal(await history.locator(".skill-history-row").count(), 2);
  assert.match(await history.innerText(), /v1/);
  assert.match(await history.innerText(), /v2/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ name, bound: true, versions: 2,
    mobileOverflow: false, pageErrors: errors }));
} finally {
  await browser.close();
}
