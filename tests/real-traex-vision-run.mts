import { randomInt, randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { readFileSync } from "node:fs";
import { query, pool } from "../packages/core/src/db.ts";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

const base = "http://127.0.0.1:3841/api";
const formUrl = "https://www.selenium.dev/selenium/web/web-form.html";
const expected = String(randomInt(100000, 1000000));
const proxy = loadTestProxyConfig();
const apiKey = proxy.apiKey;
const runtimeToken = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];
let cookie = "";
let profileId: string | null = null;

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
  const observation = await runtime("browser_read") as {
    observationId: string; elements: Array<{ ref: string; label: string }>;
  };
  const textInput = observation.elements.find(element => element.label.includes("Text input"));
  if (!textInput) throw new Error("Test form text input is unavailable");
  await runtime("browser_fill", { observationId: observation.observationId,
    ref: textInput.ref, value: expected });

  const profile = (await api("/model-profiles", "POST", {
    name: `TraeX Gemini visual run ${Date.now()}`, provider: "openai-compatible",
    modelId: "traex/Gemini-3-Flash-Preview", baseUrl: proxy.baseUrl, apiKey,
    capabilities: { text: true, tools: true, vision: true, streaming: true },
  })).profile;
  profileId = profile.id;
  if (!profile.capabilities?.vision) throw new Error("Model profile lost vision capability");
  const bot = (await api("/bots", "POST", {
    name: `Vision run ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profileId,
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "当前共享浏览器已经显示一份公开测试表单，Text input 输入框里有六位数字。请只调用 browser_screenshot，通过截图像素读出这个数字；不要调用 browser_read，也不要重新打开网页。最终只回复六位数字，无法辨认时回复 UNKNOWN。",
    requestId: randomUUID(), deliverable: "answer",
  });
  let run = submitted.run;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    run = (await api(`/runs/${run.id}`)).run;
    if (["succeeded", "failed", "canceled"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const calls = await query<{ name: string; status: string }>(
    "SELECT name,status FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal", [run.id],
  );
  const steps = await query<{ input_snapshot: unknown; usage_json: unknown }>(
    "SELECT input_snapshot,usage_json FROM model_steps WHERE run_id=$1 ORDER BY ordinal", [run.id],
  );
  const snapshots = JSON.stringify(steps.rows.map(step => step.input_snapshot));
  const actual = (run.resultText || "").trim().replace(/[^0-9]/g, "");
  const visualCall = calls.rows.some(call => call.name === "browser_screenshot" && call.status === "succeeded");
  const domRead = calls.rows.some(call => call.name === "browser_read");
  console.log(JSON.stringify({ runId: run.id, status: run.status, error: run.error,
    expected, actual, visualCall, domRead, calls: calls.rows, modelSteps: steps.rows.length,
    snapshotBytes: Buffer.byteLength(snapshots), snapshotContainsImageBytes: snapshots.includes('"type":"file"'),
    usage: steps.rows.map(step => step.usage_json), passed: run.status === "succeeded" &&
      actual === expected && visualCall && !domRead && !snapshots.includes('"type":"file"') }));
  if (run.status !== "succeeded" || actual !== expected || !visualCall || domRead ||
    snapshots.includes('"type":"file"')) process.exitCode = 1;
} finally {
  if (profileId) await query("UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=$1", [profileId]);
  await pool.end();
}
