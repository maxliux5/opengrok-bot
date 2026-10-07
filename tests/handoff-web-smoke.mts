import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { artifactDir } from "../packages/core/src/config.ts";
import { createSession } from "../packages/core/src/accounts.ts";
import { pool, query } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

try {
  const database = await query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(database.rows[0].name, "opengrok_handoff_20261006", "refusing non-isolated DB");
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE username='handoff_smoke'");
  assert.ok(owner.rows[0]);
  const token = await createSession(owner.rows[0].id);
  async function api(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { cookie: `opengrok_session=${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json() as Record<string, any>;
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  }
  const bots = (await api("/bots")).bots as Array<{ id: string; name: string }>;
  const a = bots.find(item => item.name === "Research A");
  const b = bots.find(item => item.name === "Review B");
  assert.ok(a && b);
  const marker = `网页交接验证 ${randomUUID().slice(0, 8)}`;
  const conversation = (await api(`/bots/${a.id}/conversations`, "POST", {})).conversation;
  const root = (await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: marker, requestId: randomUUID(), deliverable: "answer",
  })).run;
  const artifactId = randomUUID();
  const markdown = Buffer.from("# Web 交接材料\n\n结论：已核对。\n", "utf8");
  await mkdir(join(artifactDir, root.id), { recursive: true, mode: 0o700 });
  await writeFile(join(artifactDir, root.id, `${artifactId}.md`), markdown,
    { flag: "wx", mode: 0o600 });
  await query(
    `INSERT INTO artifacts(id,owner_id,run_id,title,mime_type,sha256,size_bytes,storage_path,source_refs)
     VALUES ($1,$2,$3,'Web交接材料.md','text/markdown; charset=utf-8',$4,$5,$6,'[]')`,
    [artifactId, owner.rows[0].id, root.id,
      createHash("sha256").update(markdown).digest("hex"), markdown.length,
      `${root.id}/${artifactId}.md`],
  );

  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktop.addCookies([{ name: "opengrok_session", value: token,
    url: "http://127.0.0.1:8444/" }]);
  const page = await desktop.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:8444/", { waitUntil: "networkidle" });
  await page.locator(".bot-row").filter({ hasText: "Research A" }).click();
  await page.locator(".conversation-row").filter({ hasText: marker }).click();
  await page.getByRole("tab", { name: "活动" }).click();
  await page.getByRole("button", { name: "交接给其他 Bot" }).click();
  const dialog = page.getByRole("dialog", { name: "交接给其他 Bot" });
  await dialog.getByLabel("目标 Bot").selectOption(b.id);
  await dialog.getByLabel("任务", { exact: true }).fill("核对这份 Web 材料");
  await dialog.getByLabel("验收标准").fill("说明材料的结论");
  await dialog.getByRole("checkbox", { name: "Web交接材料.md" }).check();
  await page.screenshot({ path: ".local/handoff-web-modal-desktop.png" });
  await dialog.getByRole("button", { name: "创建子任务" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("Research A", { exact: true }).first().waitFor();
  await page.locator(".handoff-links").getByRole("button", { name: /上游任务/ }).waitFor();
  assert.match(await page.locator(".chat-title").innerText(), /Review B/);
  await page.screenshot({ path: ".local/handoff-web-child-desktop.png" });
  await page.locator(".handoff-links").getByRole("button", { name: /上游任务/ }).click();
  await page.locator(".handoff-links").getByRole("button", { name: /子任务/ }).waitFor();
  assert.match(await page.locator(".chat-title").innerText(), /Research A/);
  const links = await api(`/runs/${root.id}/handoffs`);
  assert.equal(links.children.length, 1);
  assert.deepEqual(links.children[0].artifactIds, [artifactId]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobile.addCookies([{ name: "opengrok_session", value: token,
    url: "http://127.0.0.1:8444/" }]);
  const phone = await mobile.newPage();
  phone.on("pageerror", error => errors.push(error.message));
  await phone.goto("http://127.0.0.1:8444/", { waitUntil: "networkidle" });
  await phone.getByRole("button", { name: "打开导航" }).click();
  await phone.locator(".bot-row").filter({ hasText: "Research A" }).click();
  await phone.getByRole("button", { name: "打开导航" }).click();
  await phone.locator(".conversation-row").filter({ hasText: marker }).click();
  await phone.getByRole("button", { name: /工作区/ }).click();
  await phone.getByRole("tab", { name: "活动" }).click();
  await phone.locator(".handoff-links").getByRole("button", { name: /子任务/ }).waitFor();
  await phone.getByRole("button", { name: "交接给其他 Bot" }).click();
  await phone.screenshot({ path: ".local/handoff-web-modal-mobile.png" });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ rootRunId: root.id, childRunId: links.children[0].id,
    artifactId, desktopOverflow: false, mobileOverflow: false, pageErrors: errors }));
} finally {
  await browser?.close();
  await pool.end();
}
