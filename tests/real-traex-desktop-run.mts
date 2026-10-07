import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { query, pool } from "../packages/core/src/db.ts";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

const base = "http://127.0.0.1:3841/api";
const formUrl = "https://www.selenium.dev/selenium/web/web-form.html";
const expected = `Desk-${randomInt(100000, 1000000)}`;
const proxy = loadTestProxyConfig();
const apiKey = proxy.apiKey;
const runtimeToken = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];
let cookie = "";
let profileId: string | null = null;
let runId: string | null = null;

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
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

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  await runtime("browser_open", { url: formUrl });
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const page = await runtime("browser_read").catch(() => null);
    if (page?.text?.includes("Textarea")) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true);

  const profile = (await api("/model-profiles", "POST", {
    name: `TraeX desktop ${Date.now()}`, provider: "openai-compatible",
    modelId: "traex/Gemini-3-Flash-Preview", baseUrl: proxy.baseUrl, apiKey,
    capabilities: { text: true, tools: true, vision: true, streaming: true },
  })).profile;
  profileId = profile.id;
  const bot = (await api("/bots", "POST", {
    name: `Desktop Gemini ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profileId, capabilities: ["desktop"],
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: `当前共享 Linux 桌面已打开公开 Selenium Web form。请只使用 desktop_observe、desktop_click、desktop_type、desktop_key，把 Textarea 多行文本框填写为 ${expected}。为隔离验证工具链，人工已确认文本框内部坐标是 x=250,y=385；先截图获取 observationId，随后严格点击此坐标，点击后重新截图取得新的 observationId，再输入文本。不要自行估算或改动坐标。不要使用 browser_*、shell_exec。验收程序会独立回读最终值。最后简短回复。`,
    requestId: randomUUID(), deliverable: "answer",
  });
  runId = submitted.run.id;
  let run = submitted.run;
  const approvals: Array<{ toolName: string; decision: string; preview: boolean;
    args: Record<string, unknown> }> = [];
  const handled = new Set<string>();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const pending = (await api("/approvals")).approvals.filter((item: { runId: string }) => item.runId === runId);
    for (const item of pending) {
      if (handled.has(item.id)) continue;
      const allowed = item.toolName === "desktop_click"
        ? item.args.x >= 140 && item.args.x <= 490 && item.args.y >= 346 && item.args.y <= 425 &&
          ["left", undefined].includes(item.args.button)
        : item.toolName === "desktop_type" ? item.args.text === expected
          : item.toolName === "desktop_key" ? item.args.key === "Ctrl+A" : false;
      const preview = Boolean(item.previewArtifactId && item.previewWidth === 1440 &&
        item.previewHeight === 900);
      const decision = allowed && preview ? "approve" : "reject";
      await api(`/approvals/${item.id}/decision`, "POST", { decision });
      handled.add(item.id);
      approvals.push({ toolName: item.toolName, decision, preview, args: item.args });
    }
    run = (await api(`/runs/${runId}`)).run;
    if (["succeeded", "failed", "canceled", "reconciling"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const observation = await runtime("browser_read") as {
    elements: Array<{ label: string; value?: string }>;
  };
  const actual = observation.elements.find(item => item.label.includes("Textarea"))?.value;
  const calls = await query<{ name: string; status: string; result: unknown }>(
    "SELECT name,status,result FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal", [runId],
  );
  const steps = await query<{ input_snapshot: unknown }>(
    "SELECT input_snapshot FROM model_steps WHERE run_id=$1 ORDER BY ordinal", [runId],
  );
  const snapshots = JSON.stringify(steps.rows.map(step => step.input_snapshot));
  const images = (await api(`/runs/${runId}/artifacts`)).artifacts.filter(
    (item: { mimeType: string }) => item.mimeType === "image/png",
  );
  const pass = run.status === "succeeded" && actual === expected &&
    ["desktop_observe", "desktop_click", "desktop_type"].every(name =>
      calls.rows.some(call => call.name === name && call.status === "succeeded")) &&
    !calls.rows.some(call => call.name.startsWith("browser_") || call.name === "shell_exec") &&
    approvals.length >= 2 && approvals.every(item => item.decision === "approve" && item.preview) &&
    images.length >= 2 && !snapshots.includes('"type":"file"');
  console.log(JSON.stringify({ runId, status: run.status, error: run.error, expected, actual,
    calls: calls.rows.map(call => ({ name: call.name, status: call.status })), approvals,
    screenshotCount: images.length, snapshotBytes: Buffer.byteLength(snapshots), passed: pass }));
  if (!pass) process.exitCode = 1;
} finally {
  if (runId) await api(`/runs/${runId}/cancel`, "POST").catch(() => undefined);
  if (profileId) await query("UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=$1", [profileId]);
  await pool.end();
}
