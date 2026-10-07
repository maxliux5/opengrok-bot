import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool, query } from "../packages/core/src/db.ts";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

const base = "http://127.0.0.1:3841/api";
const proxy = loadTestProxyConfig();
const apiKey = proxy.apiKey;
const runtimeToken = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];
const marker = `SWITCH-${randomInt(100000, 1000000)}`;
const path = `provider-switch-${marker}.txt`;
let cookie = "";
const profileIds: string[] = [];
const runIds: string[] = [];

async function api(pathname: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function runtime(name: string, args: Record<string, unknown> = {}) {
  const response = await fetch("http://127.0.0.1:3843/operation", {
    method: "POST",
    headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args, controlEpoch: 1, operationId: randomUUID(),
      deadline: Date.now() + 60_000 }),
    signal: AbortSignal.timeout(65_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${name}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function runTask(conversationId: string, text: string) {
  const submitted = await api(`/conversations/${conversationId}/messages`, "POST", {
    text, requestId: randomUUID(), deliverable: "answer",
  });
  const id: string = submitted.run.id;
  runIds.push(id);
  let run = submitted.run;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    run = (await api(`/runs/${id}`)).run;
    if (["succeeded", "failed", "canceled", "reconciling"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const calls = (await query<{ name: string; status: string; result: unknown }>(
    "SELECT name,status,result FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal", [id],
  )).rows;
  const step = await query<{ model_profile_id: string }>(
    "SELECT model_profile_id FROM model_steps WHERE run_id=$1 ORDER BY ordinal LIMIT 1", [id],
  );
  return { run, calls, modelProfileId: step.rows[0]?.model_profile_id };
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const gemini = (await api("/model-profiles", "POST", {
    name: `Switch Gemini ${Date.now()}`, provider: "openai-compatible",
    modelId: "traex/Gemini-3-Flash-Preview", baseUrl: proxy.baseUrl, apiKey,
    capabilities: { text: true, tools: true, vision: false, streaming: true },
  })).profile;
  profileIds.push(gemini.id);
  const claude = (await api("/model-profiles", "POST", {
    name: `Switch Claude ${Date.now()}`, provider: "anthropic",
    modelId: "agy/claude-sonnet-4-6", baseUrl: proxy.baseUrl, apiKey,
    capabilities: { text: true, tools: true, vision: false, streaming: false },
  })).profile;
  profileIds.push(claude.id);
  const bot = (await api("/bots", "POST", {
    name: `Provider switch ${Date.now()}`, description: "跨模型状态验收",
    instructions: "用户明确要求保存、读写文件或查看网页时，必须调用对应工具，以工具回执为准。",
    modelProfileId: gemini.id, capabilities: ["public_web", "workspace", "memory"],
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const first = await runTask(conversation.id,
    `请完成三件事：1. 我明确要求你记住长期偏好“回答末尾加校验章”；2. 用 workspace_write 创建 ${path}，内容必须恰好是 ${marker}；3. 用 browser_open 打开 https://example.com/，再用 browser_read 读取。每项完成后简短回复。`);
  const firstTools = first.calls.map(call => `${call.name}:${call.status}`);
  const memories = (await api(`/bots/${bot.id}/memories`)).memories as
    Array<{ content: string }>;
  const file = await runtime("workspace_read", { path }) as { content: string };
  const page = await runtime("browser_read") as { url: string };
  const firstPassed = first.run.status === "succeeded" &&
    ["remember", "workspace_write", "browser_open", "browser_read"].every(name =>
      first.calls.some(call => call.name === name && call.status === "succeeded")) &&
    memories.some(memory => memory.content.includes("校验章")) &&
    file.content === marker && page.url.startsWith("https://example.com/") &&
    first.modelProfileId === gemini.id;
  console.log(JSON.stringify({ stage: "gemini", runId: first.run.id, status: first.run.status,
    error: first.run.error, tools: firstTools, memoryCount: memories.length,
    fileMatches: file.content === marker, pageUrl: page.url, passed: firstPassed }));
  assert.equal(firstPassed, true, "Gemini 初始状态未完整创建");

  const switched = (await api(`/bots/${bot.id}`, "PATCH", {
    modelProfileId: claude.id, expectedRevision: bot.revision,
  })).bot;
  assert.equal(switched.id, bot.id);
  assert.equal(switched.modelProfileId, claude.id);
  const second = await runTask(conversation.id,
    `现在模型已切换。请用 workspace_read 读取 ${path}，用 memory_search 查找“校验章”，并用 browser_read 回读当前浏览器。最终答复写出文件全文、记忆偏好和网页 URL。不要调用 browser_open。`);
  const secondTools = second.calls.map(call => `${call.name}:${call.status}`);
  const messages = (await api(`/conversations/${conversation.id}/messages`)).messages as
    Array<{ role: string; content: string }>;
  const preserved = messages.some(message => message.role === "user" &&
    message.content.includes(marker));
  const secondPassed = second.run.status === "succeeded" &&
    ["workspace_read", "memory_search", "browser_read"].every(name =>
      second.calls.some(call => call.name === name && call.status === "succeeded")) &&
    !second.calls.some(call => call.name === "browser_open") &&
    second.modelProfileId === claude.id && preserved &&
    second.run.resultText?.includes(marker) &&
    second.run.resultText?.includes("校验章") &&
    second.run.resultText?.includes("example.com");
  console.log(JSON.stringify({ stage: "claude", runId: second.run.id, status: second.run.status,
    error: second.run.error, tools: secondTools, historyPreserved: preserved,
    resultText: second.run.resultText, passed: secondPassed }));
  assert.equal(Boolean(secondPassed), true, "切换到 Anthropic 协议后状态未完整复用");
} finally {
  for (const id of runIds) await api(`/runs/${id}/cancel`, "POST").catch(() => undefined);
  if (profileIds.length) await query("UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=ANY($1::uuid[])",
    [profileIds]);
  await pool.end();
}
