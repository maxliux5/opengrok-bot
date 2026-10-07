import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
const context = await browser.newContext({ baseURL: "http://127.0.0.1:5174",
  viewport: { width: 1280, height: 850 } });
const page = await context.newPage();
try {
  const login = await context.request.post("/api/login", {
    data: { username: "smoke", password: testPassword },
  });
  assert.equal(login.ok(), true);
  await page.goto("/");
  await page.locator(".bot-row").first().waitFor();
  await page.getByTitle("Bot 设置").click();
  await page.getByRole("button", { name: "模型配置", exact: true }).click();
  const vision = page.getByRole("checkbox", { name: "视觉输入" });
  const text = page.getByRole("checkbox", { name: "文本" });
  assert.equal(await text.isChecked(), true);
  assert.equal(await text.isDisabled(), true);
  assert.equal(await vision.isChecked(), false);
  await vision.check();
  await page.screenshot({ path: ".local/model-capabilities-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const label of ["文本", "工具调用", "视觉输入", "流式输出"]) {
    const box = await page.getByRole("checkbox", { name: label }).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${label} overflows`);
  }
  await page.screenshot({ path: ".local/model-capabilities-mobile.png" });
  const name = `Vision UI ${Date.now()}`;
  await page.getByRole("textbox", { name: "配置名称" }).fill(name);
  await page.getByRole("textbox", { name: "模型 ID" }).fill("fake-vision");
  await page.getByRole("textbox", { name: "API 地址" }).fill("http://127.0.0.1:3850/v1");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("button", { name: "保存 Bot" }).waitFor();
  const profilesResponse = await context.request.get("/api/model-profiles");
  assert.equal(profilesResponse.ok(), true);
  const profiles = (await profilesResponse.json()).profiles;
  const profile = profiles.find(item => item.name === name);
  assert.equal(profile?.capabilities?.vision, true);
  assert.equal(profile?.capabilities?.tools, true);
  console.log(JSON.stringify({ profileId: profile.id, capabilities: profile.capabilities,
    desktopScreenshot: ".local/model-capabilities-desktop.png",
    mobileScreenshot: ".local/model-capabilities-mobile.png", mobileOverflow: false }));
} finally {
  await context.close();
  await browser.close();
}
