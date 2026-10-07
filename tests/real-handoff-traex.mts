import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBot, createConversation, createModelProfile, getRun, migrate, pool,
  query, setupOwner, submitMessage } from "../packages/core/src/index.ts";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

const root = resolve(import.meta.dirname, "..");
const databaseName = process.env.OPENGROK_REAL_HANDOFF_DB_NAME || "opengrok_real_handoff_20261006";
assert.match(databaseName, /^opengrok_real_handoff_\d{8}(?:_[a-z])?$/);
const dataDirName = databaseName === "opengrok_real_handoff_20261006"
  ? "real-handoff-20261006" : databaseName;
assert.equal(resolve(process.env.OPENGROK_DATA_DIR || ""),
  resolve(root, `.local/${dataDirName}`), "必须使用专属测试目录");
assert.equal((await query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name,
  databaseName, "必须使用专属真实交接数据库");
await migrate();
assert.equal((await query<{ count: string }>("SELECT count(*)::text AS count FROM users")).rows[0].count,
  "0", "真实交接测试只在全新数据库运行");

const proxy = loadTestProxyConfig();
const apiKey = proxy.apiKey;
const owner = await setupOwner("real-handoff", `handoff-${randomUUID()}`);
let realProfileId: string | null = null;
const workers: ChildProcess[] = [];
const logs: string[] = [];

const fake = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const userText = input.messages.filter((message: { role: string }) => message.role === "user")
      .map((message: { content: unknown }) => JSON.stringify(message.content)).join("\n");
    const marker = userText.match(/HND-[A-Z0-9-]+/)?.[0];
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000),
      model: input.model, choices: [{ index: 0, message: {
        role: "assistant", content: marker ? `审阅 Bot 已核对 ${marker}` : "交接内容缺少校验代号。",
      }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    }));
  } catch (error) {
    console.error("child fixture failed:", error);
    response.writeHead(500).end();
  }
});

async function waitTerminal(runId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(owner.id, runId);
    if (["succeeded", "failed", "canceled", "reconciling"].includes(run.status)) return run;
    await delay(300);
  }
  throw new Error(`Run ${runId} 超时：${logs.slice(-20).join("")}`);
}

try {
  await new Promise<void>((resolveListen, reject) => {
    fake.once("error", reject);
    fake.listen(3893, "127.0.0.1", resolveListen);
  });
  const parentProfile = await createModelProfile(owner.id, {
    name: "TraeX Gemini handoff", provider: "openai-compatible",
    modelId: "traex/Gemini-3-Flash-Preview", baseUrl: proxy.baseUrl, apiKey,
    capabilities: { text: true, tools: true, vision: false, streaming: true },
  });
  realProfileId = parentProfile.id;
  const childProfile = await createModelProfile(owner.id, {
    name: "Fixed child", provider: "openai-compatible", modelId: "handoff-child-fixture",
    baseUrl: "http://127.0.0.1:3893/v1",
    capabilities: { text: true, tools: false, vision: false, streaming: false },
  });
  const parentBot = await createBot(owner.id, {
    name: "项目协调", description: "负责拆分与交接任务", instructions: "用中文回答。",
    modelProfileId: parentProfile.id, capabilities: ["delegate"],
  });
  const childBot = await createBot(owner.id, {
    name: "Review B", description: "独立核对交接任务的细节与校验代号", instructions: "用中文回答。",
    modelProfileId: childProfile.id, capabilities: [],
  });
  const worker = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/index.ts"], {
    cwd: root, env: { ...process.env, OPENGROK_HOST_URL: "http://127.0.0.1:3894" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker.stdout?.on("data", chunk => logs.push(String(chunk)));
  worker.stderr?.on("data", chunk => logs.push(String(chunk)));
  workers.push(worker);
  const prompts = [
    (marker: string) => `请把核对代号 ${marker} 是否完整传给下游的工作交给 Review B。写清验收标准，交接后告诉我任务已经交给谁。`,
    (marker: string) => `请让独立审阅 Bot Review B 检查交接材料中的校验代号 ${marker}，由它完成核对；你负责发起交接。`,
    (marker: string) => `我希望 Review B 单独确认 ${marker}。请安排它执行并说明你给它的验收要求。`,
  ];
  const outcomes: Array<Record<string, unknown>> = [];
  for (const [index, prompt] of prompts.entries()) {
    const marker = `HND-${randomUUID().slice(0, 8).toUpperCase()}`;
    const conversation = await createConversation(owner.id, parentBot.id);
    const submitted = await submitMessage(owner.id, conversation.id, {
      text: prompt(marker), requestId: randomUUID(), deliverable: "answer",
    });
    const parent = await waitTerminal(submitted.run.id);
    const child = await query<{ id: string; bot_id: string; handoff_task: string;
      handoff_acceptance: string; status: string }>(
      "SELECT id,bot_id,handoff_task,handoff_acceptance,status FROM runs WHERE parent_run_id=$1",
      [parent.id],
    );
    const calls = await query<{ status: string; args: Record<string, unknown> }>(
      "SELECT status,args FROM tool_calls WHERE run_id=$1 AND name='delegate_to_bot' ORDER BY created_at,id",
      [parent.id],
    );
    const childRun = child.rows[0] ? await waitTerminal(child.rows[0].id) : null;
    const eventualQualified = parent.status === "succeeded" &&
      calls.rows.filter(call => call.status === "succeeded").length === 1 &&
      child.rows.length === 1 &&
      child.rows[0].bot_id === childBot.id && child.rows[0].handoff_task.includes(marker) &&
      child.rows[0].handoff_acceptance.trim().length >= 8 &&
      childRun?.status === "succeeded" && Boolean(childRun.resultText?.includes(marker));
    const firstPass = eventualQualified && calls.rows.length === 1 &&
      calls.rows[0].status === "succeeded";
    const outcome = { ordinal: index + 1, marker, parentRunId: parent.id,
      parentStatus: parent.status, parentError: parent.error, parentTokens: parent.tokenCount,
      handoffCalls: calls.rows.length, failedHandoffCalls: calls.rows.filter(call =>
        call.status === "failed").length, handoffStatus: calls.rows.at(-1)?.status || null,
      childRunId: child.rows[0]?.id || null, childStatus: childRun?.status || null,
      targetCorrect: child.rows[0]?.bot_id === childBot.id,
      taskPreservedMarker: Boolean(child.rows[0]?.handoff_task.includes(marker)),
      acceptance: child.rows[0]?.handoff_acceptance || null,
      eventualQualified, firstPass };
    outcomes.push(outcome);
    console.log(JSON.stringify(outcome));
  }
  const negativePrompts = [
    (marker: string) => `这件事由你自己处理：请直接复述校验代号 ${marker}，不要转交其他 Bot。`,
    (marker: string) => `只需要你本人简短确认收到 ${marker}；无需审阅或交接。`,
  ];
  const negativeOutcomes: Array<Record<string, unknown>> = [];
  for (const [index, prompt] of negativePrompts.entries()) {
    const marker = `HND-${randomUUID().slice(0, 8).toUpperCase()}`;
    const conversation = await createConversation(owner.id, parentBot.id);
    const submitted = await submitMessage(owner.id, conversation.id, {
      text: prompt(marker), requestId: randomUUID(), deliverable: "answer",
    });
    const parent = await waitTerminal(submitted.run.id);
    const callCount = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tool_calls WHERE run_id=$1 AND name='delegate_to_bot'",
      [parent.id],
    );
    const childCount = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM runs WHERE parent_run_id=$1", [parent.id],
    );
    const noDelegation = parent.status === "succeeded" && Number(callCount.rows[0].count) === 0 &&
      Number(childCount.rows[0].count) === 0 && Boolean(parent.resultText?.includes(marker));
    const outcome = { ordinal: index + 1, marker, parentRunId: parent.id,
      parentStatus: parent.status, parentError: parent.error,
      handoffCalls: Number(callCount.rows[0].count), childRuns: Number(childCount.rows[0].count),
      noDelegation };
    negativeOutcomes.push(outcome);
    console.log(JSON.stringify({ negative: outcome }));
  }
  console.log(JSON.stringify({ positiveAttempts: outcomes.length,
    eventualQualified: outcomes.filter(item => item.eventualQualified).length,
    firstPass: outcomes.filter(item => item.firstPass).length,
    failedHandoffCalls: outcomes.reduce((sum, item) => sum + Number(item.failedHandoffCalls), 0),
    negativeAttempts: negativeOutcomes.length,
    negativeNoDelegation: negativeOutcomes.filter(item => item.noDelegation).length,
    parentBotId: parentBot.id, childBotId: childBot.id }));
  assert.equal(outcomes.filter(item => item.firstPass).length, prompts.length,
    "明确交接任务应首次调用成功，且子 Bot 保留任务代号");
  assert.equal(outcomes.reduce((sum, item) => sum + Number(item.failedHandoffCalls), 0), 0,
    "交接工具不应产生失败调用");
  assert.equal(negativeOutcomes.filter(item => item.noDelegation).length, negativePrompts.length,
    "明确要求自行处理的任务不应交给其他 Bot");
} finally {
  for (const worker of workers) worker.kill("SIGTERM");
  await Promise.all(workers.map(async worker => {
    if (worker.exitCode !== null || worker.signalCode !== null) return;
    await Promise.race([new Promise(resolveExit => worker.once("exit", resolveExit)), delay(3000)]);
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  }));
  if (realProfileId) await query("UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=$1", [realProfileId]);
  await new Promise<void>(resolveClose => fake.close(() => resolveClose()));
  await pool.end();
}
