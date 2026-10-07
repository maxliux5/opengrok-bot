import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ baseURL: "http://127.0.0.1:5174", viewport: { width: 1280, height: 850 } });
const page = await context.newPage();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let runId;

async function api(path, method = "GET", data) {
  const response = await context.request.fetch(`/api${path}`, { method, data });
  const result = await response.json();
  assert.equal(response.ok(), true, `${method} ${path}: ${response.status()} ${JSON.stringify(result)}`);
  return result;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const name = `Web cancel ${Date.now()}`;
  const profile = (await api("/model-profiles", "POST", {
    name, provider: "openai-compatible", modelId: "test-model", baseUrl: "http://127.0.0.1:3850/v1",
  })).profile;
  const bot = (await api("/bots", "POST", {
    name, description: "", instructions: "", modelProfileId: profile.id, capabilities: ["shell"],
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const run = (await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "创建测试文件，先等待我审批。", requestId: randomUUID(), deliverable: "answer",
  })).run;
  runId = run.id;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await api(`/runs/${run.id}`)).run.status === "waiting_approval") break;
    await wait(100);
  }
  assert.equal((await api(`/runs/${run.id}`)).run.status, "waiting_approval");

  await page.goto("/");
  await page.locator(".bot-row").filter({ hasText: name }).click();
  await page.locator(".conversation-row").filter({ hasText: "创建测试文件，先等待我审批。" }).click();
  const activity = page.locator(".activity-inline");
  await activity.getByText("等待审批").waitFor();
  const stop = activity.getByRole("button", { name: "停止" });
  assert.equal(await stop.isVisible(), true);
  await page.screenshot({ path: ".local/web-cancel-approval.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.equal(await stop.isVisible(), true);
  const stopBox = await stop.boundingBox();
  assert.ok(stopBox && stopBox.x >= 0 && stopBox.x + stopBox.width <= 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: ".local/web-cancel-approval-mobile.png" });
  await stop.click();
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await api(`/runs/${run.id}`)).run.status === "canceled") break;
    await wait(100);
  }
  assert.equal((await api(`/runs/${run.id}`)).run.status, "canceled");
  assert.equal((await api("/approvals")).approvals.some(item => item.runId === run.id), false);
  await stop.waitFor({ state: "detached" });
  console.log(JSON.stringify({ runId: run.id, before: "waiting_approval", after: "canceled", pendingApproval: false }));
} finally {
  if (runId) await api(`/runs/${runId}/cancel`, "POST").catch(() => undefined);
  await context.close();
  await browser.close();
}
