import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { readFileSync } from "node:fs";
import { query, pool } from "../packages/core/src/db.ts";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

const base = "http://127.0.0.1:3841/api";
const formUrl = "https://www.selenium.dev/selenium/web/web-form.html";
const expectedName = "OpenGrok Gemini check";
const proxy = loadTestProxyConfig();
const apiKey = proxy.apiKey;
const runtimeToken = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];
let cookie = "";
let profileId: string | null = null;
let runId: string | null = null;

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function runtime(name: string, args: Record<string, unknown> = {}) {
  const response = await fetch("http://127.0.0.1:3843/operation", {
    method: "POST", headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, args, deadline: Date.now() + 60_000 }),
    signal: AbortSignal.timeout(65_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${name}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  await runtime("browser_open", { url: formUrl });

  const profile = (await api("/model-profiles", "POST", {
    name: `TraeX Gemini interaction ${Date.now()}`, provider: "openai-compatible",
    modelId: "traex/Gemini-3-Flash-Preview", baseUrl: proxy.baseUrl, apiKey,
  })).profile;
  profileId = profile.id;
  const bot = (await api("/bots", "POST", {
    name: `Gemini interaction ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profileId,
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: `请在当前可见的公开测试表单 ${formUrl} 中，仅把 Text input 填为 ${expectedName}，并勾选 Default checkbox。不要点击 Submit，不要执行 shell 命令。每一步使用 browser_read 观察，再用 browser_fill/browser_click 操作。最后读取页面确认两个值并回复。`,
    requestId: randomUUID(), deliverable: "answer",
  });
  runId = submitted.run.id;
  const decisions: Array<{ tool: string; decision: string }> = [];
  let run = submitted.run;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const pending = (await api("/approvals")).approvals.filter((item: { runId: string }) => item.runId === runId);
    for (const item of pending) {
      const allowed = item.toolName === "browser_fill" ?
        item.target.includes("Text input") && item.target.includes(formUrl) && item.args.value === expectedName :
        item.toolName === "browser_click" && item.target.includes("Default checkbox") && item.target.includes(formUrl);
      const decision = allowed ? "approve" : "reject";
      await api(`/approvals/${item.id}/decision`, "POST", { decision });
      decisions.push({ tool: item.toolName, decision });
    }
    run = (await api(`/runs/${runId}`)).run;
    if (["succeeded", "failed", "canceled", "reconciling"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  const observation = await runtime("browser_read") as { elements: Array<{ label: string; value?: string; checked?: boolean }> };
  const name = observation.elements.find(item => item.label.includes("Text input"))?.value;
  const checkbox = observation.elements.find(item => item.label.includes("Default checkbox"))?.checked;
  const calls = await query<{ name: string; status: string }>(
    "SELECT name,status FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal", [runId],
  );
  const clickIndex = calls.rows.findIndex(call => call.name === "browser_click");
  const modelReadAfterClick = clickIndex >= 0 && calls.rows.slice(clickIndex + 1)
    .some(call => call.name === "browser_read" && call.status === "succeeded");
  console.log(JSON.stringify({ runId, status: run.status, error: run.error, resultText: run.resultText,
    name, checkbox, decisions, modelReadAfterClick, calls: calls.rows }));
  if (run.status !== "succeeded" || name !== expectedName || checkbox !== true ||
    decisions.some(item => item.decision !== "approve") ||
    !["browser_fill", "browser_click"].every(tool =>
      calls.rows.some(call => call.name === tool && call.status === "succeeded"))) process.exitCode = 1;
} finally {
  if (profileId) await query("UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=$1", [profileId]);
  await pool.end();
}
