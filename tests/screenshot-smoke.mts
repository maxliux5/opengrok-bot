import { createHash, randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { query, pool } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
let cookie = "";
const expectRecovery = process.env.OPENGROK_EXPECT_SCREENSHOT_RECOVERY === "1";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: "Screenshot fake model", provider: "openai-compatible", modelId: "screenshot-test",
    baseUrl: "http://127.0.0.1:3855/v1",
  })).profile;
  const botName = `Screenshot ${Date.now()}`;
  const bot = (await api("/bots", "POST", { name: botName, description: "", instructions: "",
    modelProfileId: profile.id })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "打开 Example Domain 并提供真实网页截图。", requestId: randomUUID(), deliverable: "answer",
  });
  let run;
  for (let attempt = 0; attempt < 90; attempt++) {
    run = (await api(`/runs/${submitted.run.id}`)).run;
    if (["succeeded", "failed", "canceled"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const artifacts = (await api(`/runs/${submitted.run.id}/artifacts`)).artifacts;
  const image = artifacts.find((item: { mimeType: string }) => item.mimeType === "image/png");
  const calls = await query<{ name: string; status: string; result: { artifactId?: string } }>(
    "SELECT name,status,result FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal",
    [submitted.run.id],
  );
  const events = await query<{ kind: string }>(
    "SELECT kind FROM run_events WHERE run_id=$1", [submitted.run.id],
  );
  const contentResponse = image && await fetch(`${base}/artifacts/${image.id}/content?inline=1`, {
    headers: { cookie },
  });
  const bytes = contentResponse ? Buffer.from(await contentResponse.arrayBuffer()) : Buffer.alloc(0);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const journal = new DatabaseSync(".local/host-journal.sqlite", { readOnly: true });
  const screenshotOperations = journal.prepare(
    "SELECT result_json FROM operations WHERE run_id=? AND name='browser_screenshot'",
  ).all(submitted.run.id) as Array<{ result_json: string }>;
  journal.close();
  const receipt = screenshotOperations[0] && JSON.parse(screenshotOperations[0].result_json);
  const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
  let desktopImage = false;
  let mobileImage = false;
  let mobileOverflow = true;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: "opengrok_session", value: cookie.split("=")[1],
      domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:5174/");
    await page.locator(".bot-row").filter({ hasText: botName }).click();
    await page.getByRole("tab", { name: "成果" }).click();
    await page.getByTitle("预览成果").first().click();
    await page.locator(".artifact-image").waitFor();
    desktopImage = await page.locator(".artifact-image").evaluate((element: HTMLImageElement) =>
      element.complete && element.naturalWidth > 0);
    await page.screenshot({ path: ".local/screenshot-artifact-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /工作区/ }).click();
    await page.waitForTimeout(250);
    await page.locator(".artifact-image").waitFor();
    mobileImage = await page.locator(".artifact-image").evaluate((element: HTMLImageElement) =>
      element.complete && element.naturalWidth > 0);
    mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.screenshot({ path: ".local/screenshot-artifact-mobile.png" });
  } finally { await browser.close(); }
  console.log(JSON.stringify({ runId: run?.id, status: run?.status, toolCount: run?.toolCount,
    calls: calls.rows.map(call => ({ name: call.name, status: call.status })),
    imageCount: artifacts.filter((item: { mimeType: string }) => item.mimeType === "image/png").length,
    png, bytes: bytes.length, digestMatches: digest === image?.sha256,
    inline: contentResponse?.headers.get("content-disposition")?.startsWith("inline"),
    receiptDigestMatches: receipt?.sha256 === digest, receiptHasPixels: Boolean(receipt?.imageBase64),
    physicalScreenshots: screenshotOperations.length,
    unknownEvents: events.rows.filter(event => event.kind === "tool_unknown").length,
    reconciledEvents: events.rows.filter(event => event.kind === "tool_reconciled").length,
    desktopImage, mobileImage, mobileOverflow }));
  if (run?.status !== "succeeded" || run.toolCount !== 2 || !image || !png || bytes.length < 1000 ||
    digest !== image.sha256 || receipt?.sha256 !== digest || receipt?.imageBase64 ||
    screenshotOperations.length !== 1 ||
    expectRecovery && (!events.rows.some(event => event.kind === "tool_unknown") ||
      !events.rows.some(event => event.kind === "tool_reconciled")) ||
    !contentResponse?.headers.get("content-disposition")?.startsWith("inline") ||
    !calls.rows.some(call => call.name === "browser_screenshot" && call.status === "succeeded" &&
      call.result.artifactId === image.id) || !desktopImage || !mobileImage || mobileOverflow) process.exitCode = 1;
} finally { await pool.end(); }
