import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { chromium } from "playwright";

const base = "http://127.0.0.1:3841/api";
const username = "smoke";
const password = testPassword;
let cookie = "";

async function api(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

const bootstrap = await api("/bootstrap");
await api(bootstrap.initialized ? "/login" : "/setup", "POST", { username, password });
const profile = (await api("/model-profiles", "POST", {
  name: "Smoke model", provider: "openai-compatible", modelId: "test-model",
  baseUrl: "http://127.0.0.1:3850/v1",
})).profile;
const bot = (await api("/bots", "POST", {
  name: `研究助手 smoke ${Date.now()}`, description: "", instructions: "",
  modelProfileId: profile.id,
})).bot;
const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
  text: "研究 Example Domain 页面并交付带来源的 Markdown 报告",
  requestId: randomUUID(), deliverable: "report",
});
let run;
for (let attempt = 0; attempt < 90; attempt++) {
  run = (await api(`/runs/${submitted.run.id}`)).run;
  if (["succeeded", "failed", "canceled", "reconciling"].includes(run.status)) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
const artifacts = (await api(`/runs/${submitted.run.id}/artifacts`)).artifacts;
console.log(JSON.stringify({ runId: run.id, status: run.status, error: run.error,
  artifactCount: artifacts.length, resultText: run.resultText }));
if (run.status !== "succeeded" || !artifacts.length) process.exitCode = 1;
if (artifacts.length) {
  const content = await fetch(`${base}/artifacts/${artifacts[0].id}/content`, { headers: { cookie } }).then(r => r.text());
  if (!content.includes("https://example.com/")) process.exitCode = 1;
}

const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "opengrok_session", value: cookie.split("=")[1],
    domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:5174/");
  await page.waitForTimeout(1600);
  await page.screenshot({ path: ".local/run-smoke.png", fullPage: true });
  await page.getByTitle("展开电脑").click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: ".local/run-smoke-expanded.png" });
  const expanded = await page.locator(".desktop-pane.expanded").count();
  await page.getByTitle("收起电脑").click();
  await page.getByRole("tab", { name: "成果" }).click();
  await page.getByTitle("预览成果").first().click();
  await page.waitForTimeout(350);
  const preview = await page.locator(".artifact-markdown").innerText();
  const sources = await page.locator(".artifact-sources").innerText();
  await page.screenshot({ path: ".local/artifact-preview.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".local/run-smoke-mobile.png" });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await page.getByRole("button", { name: /工作区/ }).click();
  await page.screenshot({ path: ".local/artifact-preview-mobile.png" });
  const workspaceOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log(JSON.stringify({ title: await page.title(), expanded,
    mobileOverflow, workspaceOverflow, previewHasSource: preview.includes("https://example.com/"),
    sourcesVisible: sources.includes("https://example.com/"),
    bodyHasBot: await page.locator("body").innerText().then(text => text.includes("研究助手")) }));
  if (expanded !== 1 || mobileOverflow || workspaceOverflow ||
    !preview.includes("https://example.com/") || !sources.includes("https://example.com/")) process.exitCode = 1;
} finally { await browser.close(); }
