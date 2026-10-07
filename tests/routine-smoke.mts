import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool, query } from "../packages/core/src/db.ts";
import { dispatchPendingOccurrences, reserveDueRoutines } from "../packages/core/src/routines.ts";
import { defaultRunBudget } from "../packages/core/src/config.ts";

const base = "http://127.0.0.1:3841/api";
const password = process.env.OPENGROK_TEST_PASSWORD;
assert.ok(password, "OPENGROK_TEST_PASSWORD is required");
let cookie = "";

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
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
  assert.equal(db.rows[0].name, "opengrok_routines_20261006", "refusing non-isolated DB");
  assert.equal((await request("/routines")).status, 401);
  const bootstrap = await api("/bootstrap");
  if (!bootstrap.initialized) await api("/setup", "POST", { username: "routine-smoke", password });
  else await api("/login", "POST", { username: "routine-smoke", password });

  const profile = (await api("/model-profiles", "POST", {
    name: "Routine fake model", provider: "openai-compatible", modelId: "routine-fake",
    baseUrl: "http://127.0.0.1:3850/v1",
    capabilities: { text: true, tools: false, vision: false, streaming: false },
  })).profile;
  const bot = (await api("/bots", "POST", {
    name: `Routine Bot ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id, capabilities: ["public_web", "artifact", "memory"],
  })).bot;
  const skill = (await api("/skills", "POST", {
    name: "例程核验", summary: "保留版本", inputGuide: "输入目标",
    steps: ["核对输入"], verification: "核对结果", requiredCapabilities: ["public_web"],
    sourceRunId: null,
  })).skill;
  const input = { botId: bot.id, name: "每日核验", timeZone: "Asia/Shanghai",
    localTime: "09:30", inputText: "输出例程测试结果", deliverable: "answer",
    budget: { ...defaultRunBudget, maxModelSteps: 3, maxToolCalls: 4, maxTokens: 3000 },
    skillId: skill.skillId };
  assert.equal((await request("/routines", "POST", { ...input, timeZone: "Invalid/Zone" })).status, 422);
  const routine = (await api("/routines", "POST", input)).routine;
  assert.equal(routine.skillVersion, 1);
  assert.equal(routine.budget.maxModelSteps, 3);
  const requestId = randomUUID();
  const first = (await api(`/routines/${routine.id}/test`, "POST", { requestId })).occurrence;
  const repeated = (await api(`/routines/${routine.id}/test`, "POST", { requestId })).occurrence;
  assert.equal(first.id, repeated.id);
  assert.equal(first.runId, repeated.runId);
  assert.equal((await api(`/runs/${first.runId}`)).run.budget.maxModelSteps, 3);
  assert.equal((await api(`/runs/${first.runId}/skills`)).versions[0].version, 1);

  await api(`/skills/${skill.skillId}`, "PATCH", {
    name: "例程核验新版", summary: "保留版本", inputGuide: "输入目标",
    steps: ["核对新输入"], verification: "核对结果", requiredCapabilities: ["public_web"],
    sourceRunId: null, expectedVersion: 1,
  });
  const pinned = (await api(`/routines/${routine.id}/test`, "POST", { requestId: randomUUID() })).occurrence;
  assert.equal((await api(`/runs/${pinned.runId}/skills`)).versions[0].version, 1);
  assert.equal((await request(`/routines/${routine.id}`, "PATCH", {
    expectedRevision: routine.revision + 1, name: "冲突",
  })).status, 409);
  const updated = (await api(`/routines/${routine.id}`, "PATCH", {
    expectedRevision: routine.revision, skillId: skill.skillId,
  })).routine;
  assert.equal(updated.skillVersion, 2);
  const latest = (await api(`/routines/${routine.id}/test`, "POST", { requestId: randomUUID() })).occurrence;
  assert.equal((await api(`/runs/${latest.runId}/skills`)).versions[0].version, 2);

  await query("UPDATE routines SET next_fire_at=now()-interval '10 days' WHERE id=$1", [routine.id]);
  const reserved = await reserveDueRoutines(new Date());
  assert.equal(reserved, 1);
  assert.equal(await reserveDueRoutines(new Date()), 0);
  const scheduledBefore = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM routine_occurrences WHERE routine_id=$1 AND trigger='scheduled'",
    [routine.id],
  );
  assert.equal(Number(scheduledBefore.rows[0].count), 1);
  await Promise.all([dispatchPendingOccurrences(), dispatchPendingOccurrences()]);
  const scheduled = (await api(`/routines/${routine.id}/occurrences`)).occurrences
    .filter((item: { trigger: string }) => item.trigger === "scheduled");
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].runId);
  assert.ok(new Date((await api(`/routines/${routine.id}`)).routine.nextFireAt) > new Date());
  assert.equal((await api(`/runs/${scheduled[0].runId}/skills`)).versions[0].version, 2);

  const paused = (await api(`/routines/${routine.id}`, "PATCH", {
    expectedRevision: updated.revision, status: "paused",
  })).routine;
  assert.equal(paused.status, "paused");
  const resumed = (await api(`/routines/${routine.id}`, "PATCH", {
    expectedRevision: paused.revision, status: "active",
  })).routine;
  assert.equal(resumed.status, "active");
  assert.ok(new Date(resumed.nextFireAt) > new Date());

  const report = (await api("/routines", "POST", {
    ...input, name: "权限撤销检查", deliverable: "report", skillId: null,
  })).routine;
  await api(`/bots/${bot.id}`, "PATCH", {
    name: bot.name, description: bot.description, instructions: bot.instructions,
    modelProfileId: bot.modelProfileId, capabilities: ["memory"], expectedRevision: bot.revision,
  });
  const denied = (await api(`/routines/${report.id}/test`, "POST", {
    requestId: randomUUID(),
  })).occurrence;
  assert.equal(denied.status, "failed");
  assert.match(denied.error, /报告任务需要/);
  assert.equal(denied.runId, null);
  const skillDenied = (await api(`/routines/${routine.id}/test`, "POST", {
    requestId: randomUUID(),
  })).occurrence;
  assert.equal(skillDenied.status, "failed");
  assert.match(skillDenied.error, /技能所需/);
  assert.equal(skillDenied.runId, null);

  for (const item of (await api(`/routines/${routine.id}/occurrences`)).occurrences) {
    if (item.runId) await api(`/runs/${item.runId}/cancel`, "POST", {});
  }
  console.log(JSON.stringify({ routineId: routine.id, manualIdempotent: first.id === repeated.id,
    pinnedVersions: [1, 2], scheduledCount: scheduled.length,
    scheduledRunId: scheduled[0].runId, denied: denied.error,
    skillDenied: skillDenied.error }));
} finally { await pool.end(); }
