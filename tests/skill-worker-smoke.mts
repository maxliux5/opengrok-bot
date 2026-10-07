import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, query } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
const password = process.env.OPENGROK_TEST_PASSWORD;
assert.ok(password, "OPENGROK_TEST_PASSWORD is required");
let cookie = "";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data as Record<string, any>;
}

async function run(botId: string) {
  const conversation = (await api(`/bots/${botId}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "请回答技能模型输入验证。", requestId: randomUUID(), deliverable: "answer",
  });
  const runId = submitted.run.id as string;
  for (let attempt = 0; attempt < 80; attempt++) {
    const current = (await api(`/runs/${runId}`)).run;
    if (["succeeded", "failed", "canceled"].includes(current.status)) {
      assert.equal(current.status, "succeeded", current.error || current.status);
      return { runId, result: JSON.parse(current.resultText) as Record<string, boolean> };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await api(`/runs/${runId}/cancel`, "POST", {});
  throw new Error(`Run ${runId} timed out`);
}

try {
  const db = await query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(db.rows[0].name, "opengrok_gemini_20261006", "refusing non-isolated DB");
  await api("/login", "POST", { username: "smoke", password });
  const skills = (await api("/skills")).skills as Array<{ skillId: string; name: string; version: number }>;
  const target = skills.find(item => item.name === "网页事实核验新版" && item.version === 2);
  assert.ok(target, "skill-smoke.mts must run first");
  const profile = (await api("/model-profiles", "POST", {
    name: `Skill worker ${Date.now()}`, provider: "openai-compatible", modelId: "skill-probe",
    baseUrl: "http://127.0.0.1:3857/v1",
    capabilities: { text: true, tools: false, vision: false, streaming: false },
  })).profile;
  async function bot(name: string, capabilities: string[]) {
    const created = (await api("/bots", "POST", {
      name, description: "", instructions: "", modelProfileId: profile.id, capabilities,
    })).bot;
    await api(`/bots/${created.id}/skills/${target.skillId}`, "PUT");
    return created;
  }
  const allowed = await bot(`Allowed skill ${Date.now()}`, ["public_web"]);
  const restricted = await bot(`Restricted skill ${Date.now()}`, ["memory"]);
  const good = await run(allowed.id);
  const denied = await run(restricted.id);
  assert.deepEqual(good.result, { currentVersion: true, currentStep: true,
    oldStep: false, capabilityDenied: false });
  assert.deepEqual(denied.result, { currentVersion: false, currentStep: false,
    oldStep: false, capabilityDenied: true });
  console.log(JSON.stringify({ allowedRun: good.runId, allowedPrompt: good.result,
    restrictedRun: denied.runId, restrictedPrompt: denied.result }));
} finally {
  await pool.end();
}
