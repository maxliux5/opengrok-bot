import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, query } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
const password = process.env.OPENGROK_TEST_PASSWORD;
assert.ok(password, "OPENGROK_TEST_PASSWORD is required");
let cookie = "";

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function api(path: string, method = "GET", body?: unknown) {
  const result = await request(path, method, body);
  assert.ok(result.status >= 200 && result.status < 300,
    `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

try {
  const db = await query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(db.rows[0].name, "opengrok_gemini_20261006", "refusing non-isolated DB");
  assert.equal((await request("/skills")).status, 401);
  const login = await api("/login", "POST", { username: "smoke", password });
  const source = await query<{ id: string }>(
    "SELECT id FROM runs WHERE owner_id=$1 AND status='succeeded' ORDER BY created_at DESC LIMIT 1",
    [login.user.id],
  );
  assert.ok(source.rows[0], "a successful source Run is required");
  const draft = await api(`/runs/${source.rows[0].id}/skill-draft`);
  assert.equal(draft.draft.sourceRunId, source.rows[0].id);

  const profile = (await api("/model-profiles", "POST", {
    name: `Skill smoke ${Date.now()}`, provider: "openai-compatible", modelId: "skill-smoke",
    baseUrl: "http://127.0.0.1:3850/v1",
    capabilities: { text: true, tools: false, vision: false, streaming: false },
  })).profile;
  async function bot(name: string, capabilities: string[]) {
    return (await api("/bots", "POST", {
      name, description: "", instructions: "", modelProfileId: profile.id, capabilities,
    })).bot;
  }
  const first = await bot(`Skill A ${Date.now()}`, ["public_web", "memory"]);
  const second = await bot(`Skill B ${Date.now()}`, ["public_web"]);
  const restricted = await bot(`Skill restricted ${Date.now()}`, ["memory"]);
  const initial = { name: "网页事实核验", summary: "读取来源后回答", inputGuide: "提供目标网址和问题。",
    steps: ["打开并读取指定页面。", "逐项核对结论与页面文本。"],
    verification: "答案附上实际读取的 URL。", requiredCapabilities: ["public_web"],
    sourceRunId: source.rows[0].id };
  const created = (await api("/skills", "POST", initial)).skill;
  assert.equal(created.version, 1);
  await api(`/bots/${first.id}/skills/${created.skillId}`, "PUT");
  await api(`/bots/${second.id}/skills/${created.skillId}`, "PUT");
  await api(`/bots/${restricted.id}/skills/${created.skillId}`, "PUT");
  const bound = (await api(`/skills/${created.skillId}`)).skill;
  assert.deepEqual(new Set(bound.boundBotIds), new Set([first.id, second.id, restricted.id]));

  async function submit(botId: string) {
    const conversation = (await api(`/bots/${botId}/conversations`, "POST", {})).conversation;
    const result = await api(`/conversations/${conversation.id}/messages`, "POST", {
      text: "请回答一个测试问题。", requestId: randomUUID(), deliverable: "answer",
    });
    return result.run.id as string;
  }
  const oldRun = await submit(first.id);
  const oldSnapshot = await api(`/runs/${oldRun}/skills`);
  assert.equal(oldSnapshot.versions[0].version, 1);
  const updated = (await api(`/skills/${created.skillId}`, "PATCH", {
    ...initial, name: "网页事实核验新版", steps: ["先确认网页来源。"], expectedVersion: 1,
  })).skill;
  assert.equal(updated.version, 2);
  assert.equal((await request(`/skills/${created.skillId}`, "PATCH", {
    ...initial, expectedVersion: 1,
  })).status, 409);
  const newRun = await submit(first.id);
  const newSnapshot = await api(`/runs/${newRun}/skills`);
  assert.equal(newSnapshot.versions[0].version, 2);
  assert.equal((await api(`/runs/${oldRun}/skills`)).versions[0].name, initial.name);
  assert.equal((await api(`/skills/${created.skillId}/versions`)).versions.length, 2);

  const restrictedRun = await submit(restricted.id);
  assert.equal((await api(`/runs/${restrictedRun}/skills`)).versions[0].version, 2);
  const capabilities = await query<{ capabilities_json: string[] }>(
    "SELECT capabilities_json FROM runs WHERE id=$1", [restrictedRun],
  );
  assert.deepEqual(capabilities.rows[0].capabilities_json, ["memory"]);
  for (const runId of [oldRun, newRun, restrictedRun]) await api(`/runs/${runId}/cancel`, "POST", {});
  console.log(JSON.stringify({ sourceRunId: source.rows[0].id, skillId: created.skillId,
    boundBots: bound.boundBotIds.length, oldRun, oldVersion: oldSnapshot.versions[0].version,
    newRun, newVersion: newSnapshot.versions[0].version, restrictedRun,
    restrictedCapabilities: capabilities.rows[0].capabilities_json }));
} finally {
  await pool.end();
}
