import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { query, pool } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
const path = `runs/${randomUUID()}/note.txt`;
let cookie = "";

async function api(url: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${url}: ${JSON.stringify(data)}`);
  return data;
}

async function run(botId: string, mode: string) {
  const conversation = (await api(`/bots/${botId}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: `工作文件测试 mode=${mode} path=${path}`, requestId: randomUUID(), deliverable: "answer",
  });
  let state;
  for (let attempt = 0; attempt < 90; attempt++) {
    state = (await api(`/runs/${submitted.run.id}`)).run;
    if (["succeeded", "failed", "canceled", "reconciling"].includes(state.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const calls = await query<{ name: string; status: string; result: Record<string, unknown> }>(
    "SELECT name,status,result FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal",
    [submitted.run.id],
  );
  return { run: state, calls: calls.rows };
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: "Workspace fake model", provider: "openai-compatible", modelId: "workspace-test",
    baseUrl: "http://127.0.0.1:3854/v1",
  })).profile;
  const bot = (await api("/bots", "POST", { name: `Workspace ${Date.now()}`,
    description: "", instructions: "", modelProfileId: profile.id })).bot;
  const created = await run(bot.id, "create");
  const overwritten = await run(bot.id, "overwrite");
  const rejected = await run(bot.id, "reject");
  const createdRead = created.calls.find(call => call.name === "workspace_read");
  const listed = created.calls.find(call => call.name === "workspace_list");
  const overwrittenRead = overwritten.calls.filter(call => call.name === "workspace_read").at(-1);
  const rejectedWrite = rejected.calls.find(call => call.name === "workspace_write");
  console.log(JSON.stringify({ path, createRun: created.run?.status,
    createCalls: created.calls.map(call => ({ name: call.name, status: call.status })),
    createRead: createdRead?.result.content, list: listed?.result.entries,
    overwriteRun: overwritten.run?.status, overwriteRead: overwrittenRead?.result.content,
    rejectRun: rejected.run?.status, rejectCall: rejectedWrite?.status,
    rejectError: rejectedWrite?.result.error }));
  if (created.run?.status !== "succeeded" || overwritten.run?.status !== "succeeded" ||
    rejected.run?.status !== "succeeded" ||
    created.calls.some(call => call.status !== "succeeded") ||
    overwritten.calls.some(call => call.status !== "succeeded") ||
    createdRead?.result.content !== "第一版工作文件\n" ||
    !Array.isArray(listed?.result.entries) ||
    !listed.result.entries.some((entry: { name: string }) => entry.name === "note.txt") ||
    overwrittenRead?.result.content !== "第二版工作文件\n" ||
    rejectedWrite?.status !== "failed" ||
    !String(rejectedWrite.result.error).includes("File already exists")) process.exitCode = 1;
} finally { await pool.end(); }
