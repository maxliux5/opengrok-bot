import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createBot, createConversation, createModelProfile, decideApproval, getBot, getRun,
  listApprovals, migrate, pool, query, setupOwner, submitMessage, createSession,
  updateBot } from "../packages/core/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const databaseName = process.env.OPENGROK_GITHUB_TEST_DB_NAME || "opengrok_github_20261006";
assert.match(databaseName, /^opengrok_github_\d{8}(?:_[a-z])?$/);
assert.equal((await query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name,
  databaseName, "必须使用专属测试数据库");
const dataDirName = databaseName === "opengrok_github_20261006" ? "github-20261006" : databaseName;
assert.equal(resolve(process.env.OPENGROK_DATA_DIR || ""), resolve(root, `.local/${dataDirName}`),
  "必须使用专属测试目录");
await migrate();
assert.equal((await query<{ count: string }>("SELECT count(*)::text AS count FROM users")).rows[0]?.count,
  "0", "测试只在全新数据库运行");

type Issue = { number: number; title: string; body: string; state: "open";
  html_url: string };
const issues = new Map<number, Issue>();
const posts: string[] = [];
let nextNumber = 1;
const logs: string[] = [];
let worker: ChildProcess | null = null;
const services: ChildProcess[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
let model: Server | null = null;
let github: Server | null = null;

function json(response: import("node:http").ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function listen(server: Server, port: number) {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

async function waitFor<T>(load: () => Promise<T | null>, label: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (value !== null) return value;
    await delay(250);
  }
  throw new Error(`${label} 超时：${logs.slice(-20).join("")}`);
}

try {
  const owner = await setupOwner("github-smoke", `test-${randomUUID()}`);
  model = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") return json(response, 404, {});
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const userText = input.messages.filter((item: { role: string }) => item.role === "user")
      .map((item: { content: unknown }) => JSON.stringify(item.content)).join("\n");
    const label = userText.match(/CASE:([a-z]+)/)?.[1];
    if (!label) return json(response, 400, { error: "missing case" });
    const usedTool = input.messages.some((item: { role: string }) => item.role === "tool");
    const message = usedTool ? { role: "assistant", content: `已处理 ${label}` } : {
      role: "assistant", content: null, tool_calls: [{ id: `call_${label}`, type: "function",
        function: { name: "github_issue_create", arguments: JSON.stringify({
          title: `测试 Issue ${label}`, body: `由 OpenGrok Bot 创建的 ${label} 测试正文。`,
        }) } }],
    };
    json(response, 200, { id: randomUUID(), object: "chat.completion",
      created: Math.floor(Date.now() / 1000), model: input.model,
      choices: [{ index: 0, message, finish_reason: usedTool ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } });
  });
  github = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    const url = new URL(request.url || "/", "http://127.0.0.1:3896");
    if (request.method === "POST" && url.pathname === "/repos/example/test-repo/issues") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw) as { title: string; body: string };
      if (input.title.includes("forbidden")) return json(response, 403, { message: "forbidden" });
      posts.push(input.title);
      const issue: Issue = { number: nextNumber++, title: input.title, body: input.body,
        state: "open", html_url: `https://github.com/example/test-repo/issues/${nextNumber - 1}` };
      issues.set(issue.number, issue);
      if (input.title.includes("lost")) {
        response.destroy();
        return;
      }
      return json(response, 201, issue);
    }
    if (request.method === "GET" && url.pathname === "/repos/example/test-repo/issues") {
      return json(response, 200, [...issues.values()].reverse());
    }
    const number = /^\/repos\/example\/test-repo\/issues\/(\d+)$/.exec(url.pathname)?.[1];
    if (request.method === "GET" && number) {
      const issue = issues.get(Number(number));
      return json(response, issue ? 200 : 404, issue || { message: "not found" });
    }
    return json(response, 404, { message: "not found" });
  });
  await listen(model, 3895);
  await listen(github, 3896);
  const profile = await createModelProfile(owner.id, { name: "GitHub fixture",
    provider: "openai-compatible", modelId: "github-fixture", baseUrl: "http://127.0.0.1:3895/v1",
    capabilities: { text: true, tools: true, vision: false, streaming: false } });
  const bot = await createBot(owner.id, { name: "Issue Bot", description: "起草并发布测试 Issue",
    instructions: "按用户请求创建 Issue。", modelProfileId: profile.id,
    capabilities: ["github_issues"] });
  const connectorEnv = { ...process.env, OPENGROK_TEST_MODE: "1",
    OPENGROK_TEST_GITHUB_BASE_URL: "http://127.0.0.1:3896/",
    OPENGROK_GITHUB_REPOSITORY: "example/test-repo", OPENGROK_GITHUB_TOKEN: "test-token" };
  worker = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/index.ts"], {
    cwd: root, env: connectorEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout?.on("data", chunk => logs.push(String(chunk)));
  worker.stderr?.on("data", chunk => logs.push(String(chunk)));

  async function submit(label: string) {
    const conversation = await createConversation(owner.id, bot.id);
    const submitted = await submitMessage(owner.id, conversation.id, {
      text: `请创建测试 Issue。CASE:${label}`, requestId: randomUUID(), deliverable: "answer",
    });
    const approval = await waitFor(async () => (await listApprovals(owner.id)).find(item =>
      item.runId === submitted.run.id) || null, `${label} 审批`);
    assert.match(approval.target, /example\/test-repo/);
    assert.equal(approval.args.title, `测试 Issue ${label}`);
    assert.equal(approval.args.body, `由 OpenGrok Bot 创建的 ${label} 测试正文。`);
    return { runId: submitted.run.id, approval };
  }

  const rejected = await submit("reject");
  assert.equal(posts.length, 0, "批准之前不能创建 Issue");
  await decideApproval(owner.id, rejected.approval.id, "reject");
  await waitFor(async () => {
    const run = await getRun(owner.id, rejected.runId);
    return ["succeeded", "failed"].includes(run.status) ? run : null;
  }, "拒绝后的 Run");
  assert.equal(posts.length, 0, "拒绝后不能创建 Issue");

  const approved = await submit("approved");
  assert.equal(posts.length, 0, "待审批时不能创建 Issue");
  const api = spawn(process.execPath, ["--import", "tsx", "apps/api/src/index.ts"], {
    cwd: root, env: { ...connectorEnv, OPENGROK_API_PORT: "3841",
      OPENGROK_WEB_ORIGIN: "http://127.0.0.1:8444" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const web = spawn(resolve(root, "node_modules/.bin/vite"),
    ["preview", "--host", "127.0.0.1", "--port", "8444", "--strictPort"], {
      cwd: resolve(root, "apps/web"),
      env: { ...connectorEnv, OPENGROK_API_TARGET: "http://127.0.0.1:3841" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  services.push(api, web);
  for (const service of services) {
    service.stdout?.on("data", chunk => logs.push(String(chunk)));
    service.stderr?.on("data", chunk => logs.push(String(chunk)));
  }
  await waitFor(async () => {
    try { return (await fetch("http://127.0.0.1:3841/api/health")).ok ? true : null; }
    catch { return null; }
  }, "隔离 API", 15_000);
  await waitFor(async () => {
    try { return (await fetch("http://127.0.0.1:8444/")).ok ? true : null; }
    catch { return null; }
  }, "隔离 Web", 15_000);
  const session = await createSession(owner.id);
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined });
  const browserErrors: string[] = [];
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktop.addCookies([{ name: "opengrok_session", value: session, url: "http://127.0.0.1:8444/" }]);
  const page = await desktop.newPage();
  page.on("pageerror", error => browserErrors.push(error.message));
  await page.goto("http://127.0.0.1:8444/", { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "审批" }).click();
  const approvalCard = page.locator(".approval-item").filter({ hasText: "测试 Issue approved" });
  await approvalCard.waitFor();
  assert.match(await approvalCard.innerText(), /example\/test-repo/);
  assert.match(await approvalCard.locator(".approval-value.external pre").innerText(), /approved 测试正文/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "docs/screenshots/github-approval-desktop.png" });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobile.addCookies([{ name: "opengrok_session", value: session, url: "http://127.0.0.1:8444/" }]);
  const phone = await mobile.newPage();
  phone.on("pageerror", error => browserErrors.push(error.message));
  await phone.goto("http://127.0.0.1:8444/", { waitUntil: "networkidle" });
  await phone.getByRole("button", { name: /工作区/ }).click();
  await phone.getByRole("tab", { name: "审批" }).click();
  const mobileCard = phone.locator(".approval-item").filter({ hasText: "测试 Issue approved" });
  await mobileCard.waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await phone.screenshot({ path: "docs/screenshots/github-approval-mobile.png" });
  assert.deepEqual(browserErrors, []);
  await approvalCard.getByRole("button", { name: "批准" }).click();
  await waitFor(async () => {
    const current = (await query<{ status: string }>(
      "SELECT status FROM approvals WHERE id=$1", [approved.approval.id],
    )).rows[0];
    return current?.status === "approved" ? true : null;
  }, "Web 批准提交", 10_000);
  const approvedRun = await waitFor(async () => {
    const run = await getRun(owner.id, approved.runId);
    return ["succeeded", "failed"].includes(run.status) ? run : null;
  }, "批准后的 Run");
  assert.equal(approvedRun.status, "succeeded", approvedRun.error || undefined);
  assert.deepEqual(posts, ["测试 Issue approved"]);
  const approvedCall = (await query<{ status: string; result: { url: string } }>(
    "SELECT status,result FROM tool_calls WHERE run_id=$1 AND name='github_issue_create'",
    [approved.runId],
  )).rows[0];
  assert.equal(approvedCall.status, "succeeded");
  assert.equal(approvedCall.result.url, "https://github.com/example/test-repo/issues/1");

  const revoked = await submit("revoked");
  worker.kill("SIGTERM");
  await waitFor(async () => worker?.exitCode !== null || worker?.signalCode !== null ? true : null,
    "旧 Worker 退出", 10_000);
  worker = null;
  await decideApproval(owner.id, revoked.approval.id, "approve");
  const currentBot = await getBot(owner.id, bot.id);
  await updateBot(owner.id, bot.id, { expectedRevision: currentBot.revision, capabilities: [] });
  worker = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/index.ts"], {
    cwd: root, env: connectorEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout?.on("data", chunk => logs.push(String(chunk)));
  worker.stderr?.on("data", chunk => logs.push(String(chunk)));
  const revokedRun = await waitFor(async () => {
    const run = await getRun(owner.id, revoked.runId);
    return ["succeeded", "failed"].includes(run.status) ? run : null;
  }, "撤销授权后的 Run");
  assert.equal(revokedRun.status, "failed");
  assert.deepEqual(posts, ["测试 Issue approved"], "旧审批不能越过即时撤销");
  const withoutCapability = await getBot(owner.id, bot.id);
  await updateBot(owner.id, bot.id, {
    expectedRevision: withoutCapability.revision, capabilities: ["github_issues"],
  });

  const forbidden = await submit("forbidden");
  await decideApproval(owner.id, forbidden.approval.id, "approve");
  const forbiddenRun = await waitFor(async () => {
    const run = await getRun(owner.id, forbidden.runId);
    return ["succeeded", "failed"].includes(run.status) ? run : null;
  }, "GitHub 403 后的 Run");
  assert.equal(forbiddenRun.status, "succeeded");
  const forbiddenCall = (await query<{ status: string; result: { error: string } }>(
    "SELECT status,result FROM tool_calls WHERE run_id=$1 AND name='github_issue_create'",
    [forbidden.runId],
  )).rows[0];
  assert.equal(forbiddenCall.status, "failed");
  assert.match(forbiddenCall.result.error, /HTTP 403/);
  assert.deepEqual(posts, ["测试 Issue approved"], "GitHub 403 不能创建 Issue");

  const lost = await submit("lost");
  await decideApproval(owner.id, lost.approval.id, "approve");
  const lostRun = await waitFor(async () => {
    const run = await getRun(owner.id, lost.runId);
    return ["succeeded", "failed"].includes(run.status) ? run : null;
  }, "丢响应后的 Run", 120_000);
  assert.equal(lostRun.status, "succeeded", lostRun.error || undefined);
  assert.deepEqual(posts, ["测试 Issue approved", "测试 Issue lost"], "丢响应后不能重复 POST");
  const events = (await query<{ kind: string }>(
    "SELECT kind FROM run_events WHERE run_id=$1 ORDER BY sequence", [lost.runId],
  )).rows.map(item => item.kind);
  assert.ok(events.includes("tool_unknown") && events.includes("tool_reconciled"),
    "丢响应后必须先记录未知效果，再按外部标记核对");
  const ledger = await query<{ status: string; repository: string }>(
    "SELECT status,repository FROM github_issue_operations ORDER BY created_at",
  );
  assert.equal(ledger.rows.length, 3);
  assert.deepEqual(ledger.rows.map(row => row.status), ["succeeded", "failed", "succeeded"]);
  assert.ok(ledger.rows.every(row => row.repository === "example/test-repo"));
  console.log(JSON.stringify({ rejectedPosts: 0, revokedPosts: 0, forbiddenIssueCreated: false,
    approvedIssue: approvedCall.result.url,
    lostResponseIssue: "https://github.com/example/test-repo/issues/2", posts: posts.length,
    unknownReconciled: true }));
} finally {
  await browser?.close();
  for (const service of services) service.kill("SIGTERM");
  await Promise.all(services.map(async service => {
    if (service.exitCode !== null || service.signalCode !== null) return;
    await Promise.race([new Promise(resolveExit => service.once("exit", resolveExit)), delay(3000)]);
    if (service.exitCode === null && service.signalCode === null) service.kill("SIGKILL");
  }));
  worker?.kill("SIGTERM");
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    await Promise.race([new Promise(resolveExit => worker!.once("exit", resolveExit)), delay(3000)]);
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  }
  if (model) await new Promise<void>(resolveClose => model!.close(() => resolveClose()));
  if (github) await new Promise<void>(resolveClose => github!.close(() => resolveClose()));
  await pool.end();
}
