import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBot, createModelProfile, createRoutine, defaultRunBudget, migrate,
  nextRoutineFire, pool, query, setupOwner } from "../packages/core/src/index.ts";

const databaseName = "opengrok_wallclock_20261006";
const root = resolve(import.meta.dirname, "..");
const expectedDataDir = resolve(root, ".local/wallclock-20261006");
const modelPort = 3891;
const marker = "WALLCLOCK-20261006";
const routineName = "wallclock-longrun-20261006";
assert.equal(resolve(process.env.OPENGROK_DATA_DIR || ""), expectedDataDir,
  "墙钟验收必须使用专属数据目录");
assert.equal((await query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name,
  databaseName, "墙钟验收必须使用专属数据库");
await migrate();

type RoutineRow = { id: string; local_time: string; time_zone: string; created_at: Date };
type OccurrenceRow = { id: string; run_id: string | null; status: string; scheduled_at: Date;
  created_at: Date; request_id: string; run_status: string | null; result_text: string | null };

async function ensureRoutine(): Promise<RoutineRow> {
  const existing = await query<RoutineRow>("SELECT * FROM routines WHERE name=$1", [routineName]);
  if (existing.rows.length) {
    assert.equal(existing.rows.length, 1);
    const owner = await query<{ username: string }>("SELECT username FROM users");
    assert.deepEqual(owner.rows.map(row => row.username), ["wallclock-test"]);
    return existing.rows[0];
  }
  const users = await query<{ count: string }>("SELECT count(*)::text AS count FROM users");
  assert.equal(users.rows[0].count, "0", "已有其他账号，拒绝初始化长跑验收");
  const owner = await setupOwner("wallclock-test", `wallclock-${randomUUID()}`);
  const profile = await createModelProfile(owner.id, {
    name: "Wall-clock fixture", provider: "openai-compatible", modelId: "wallclock-fixture",
    baseUrl: `http://127.0.0.1:${modelPort}/v1`,
    capabilities: { text: true, tools: false, vision: false, streaming: false },
  });
  const bot = await createBot(owner.id, {
    name: "Wall-clock Bot", description: "", instructions: "只回复模型提供的验收标记。",
    modelProfileId: profile.id, capabilities: [],
  });
  const target = new Date((Math.floor(Date.now() / 60_000) + 2) * 60_000);
  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(target);
  const routine = await createRoutine(owner.id, {
    botId: bot.id, name: routineName, timeZone: "Asia/Shanghai", localTime,
    inputText: `请回复 ${marker}`, deliverable: "answer", skillId: null,
    budget: { ...defaultRunBudget, maxModelSteps: 3, maxToolCalls: 1, maxTokens: 4000 },
  });
  assert.equal(routine.nextFireAt, target.toISOString(), "首个触发必须来自真实未来时点");
  console.log(JSON.stringify({ event: "routine_created", routineId: routine.id,
    firstFireAt: routine.nextFireAt, secondFireAt: new Date(target.getTime() + 86_400_000).toISOString() }));
  const stored = await query<RoutineRow>("SELECT * FROM routines WHERE id=$1", [routine.id]);
  return stored.rows[0];
}

const routine = await ensureRoutine();
const firstFire = nextRoutineFire(routine.local_time, routine.time_zone, routine.created_at);
const secondFire = new Date(firstFire.getTime() + 86_400_000);
assert.ok(Date.now() < secondFire.getTime() + 300_000, "第二次触发验收期限已过");

const model = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    if (!JSON.stringify(input.messages).includes(marker)) {
      response.writeHead(422).end(JSON.stringify({ error: "routine marker missing from model input" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000),
      model: input.model, choices: [{ index: 0, message: {
        role: "assistant", content: `例程已按墙钟触发：${marker}`,
      }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    }));
  } catch (error) {
    console.error("model fixture failed:", error);
    response.writeHead(500).end();
  }
});
await new Promise<void>((resolveListen, reject) => {
  model.once("error", reject);
  model.listen(modelPort, "127.0.0.1", resolveListen);
});
const worker: ChildProcess = spawn(process.execPath,
  ["--import", "tsx", "apps/worker/src/index.ts"], {
    cwd: root, env: { ...process.env, OPENGROK_HOST_URL: "http://127.0.0.1:3894" },
    stdio: "inherit",
  });
let stopping = false;
let firstLogged = false;
let lastHeartbeat = 0;

async function inspect() {
  const rows = (await query<OccurrenceRow>(
    `SELECT o.id,o.run_id,o.status,o.scheduled_at,o.created_at,o.request_id,
      r.status AS run_status,r.result_text FROM routine_occurrences o
     LEFT JOIN runs r ON r.id=o.run_id WHERE o.routine_id=$1 AND o.trigger='scheduled'
     ORDER BY o.scheduled_at`, [routine.id],
  )).rows;
  assert.ok(rows.length <= 2, `产生了 ${rows.length} 次定时触发`);
  for (const [index, row] of rows.entries()) {
    const expected = index === 0 ? firstFire : secondFire;
    assert.equal(row.scheduled_at.toISOString(), expected.toISOString(), "触发时点偏离计划");
    assert.ok(row.created_at.getTime() >= expected.getTime(), "调度早于计划时点");
    assert.ok(row.created_at.getTime() - expected.getTime() <= 120_000,
      "调度延迟超过两分钟");
    if (row.status === "failed") throw new Error(`定时 occurrence ${row.id} 投递失败`);
    if (row.status === "pending") continue;
    assert.equal(row.status, "submitted", "定时 occurrence 状态无效");
    if (row.run_status === "failed" || row.run_status === "canceled") {
      throw new Error(`例程 Run ${row.run_id} 终止于 ${row.run_status}`);
    }
    if (row.run_status !== "succeeded") continue;
    assert.ok(row.result_text?.includes(marker), "Run 缺少模型输入标记");
    const events = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM run_events WHERE run_id=$1 AND kind='routine_triggered'",
      [row.run_id],
    );
    assert.equal(events.rows[0].count, "1", "一个 Run 必须只有一条触发事件");
    const steps = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM model_steps WHERE run_id=$1 AND status='completed'",
      [row.run_id],
    );
    assert.equal(steps.rows[0].count, "1", "每个例程 Run 应完成一次模型步骤");
  }
  if (rows[0]?.run_status === "succeeded" && !firstLogged) {
    firstLogged = true;
    console.log(JSON.stringify({ event: "first_verified", at: new Date().toISOString(),
      routineId: routine.id, occurrenceId: rows[0].id, runId: rows[0].run_id,
      scheduledAt: rows[0].scheduled_at.toISOString() }));
  }
  if (rows.length === 2 && rows.every(row => row.run_status === "succeeded")) {
    assert.notEqual(rows[0].run_id, rows[1].run_id);
    assert.notEqual(rows[0].request_id, rows[1].request_id);
    console.log(JSON.stringify({ event: "second_verified", at: new Date().toISOString(),
      routineId: routine.id, occurrenceIds: rows.map(row => row.id),
      runIds: rows.map(row => row.run_id),
      scheduledAt: rows.map(row => row.scheduled_at.toISOString()) }));
    return true;
  }
  if (Date.now() > secondFire.getTime() + 300_000) {
    throw new Error("次日自然触发未在五分钟内完成");
  }
  if (Date.now() - lastHeartbeat > 3_600_000) {
    lastHeartbeat = Date.now();
    console.log(JSON.stringify({ event: "waiting", at: new Date().toISOString(),
      scheduledCount: rows.length, nextExpected: secondFire.toISOString() }));
  }
  return false;
}

try {
  await new Promise<void>((resolveDone, reject) => {
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void inspect().then(done => {
        if (done) finish();
      }).catch(finish).finally(() => { checking = false; });
    }, 5000);
    const finish = (error?: unknown) => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      if (error) reject(error);
      else resolveDone();
    };
    worker.once("exit", (code, signal) => {
      if (!stopping) finish(new Error(`Worker exited early: ${code ?? signal}`));
    });
    process.once("SIGTERM", () => finish());
    process.once("SIGINT", () => finish());
    void inspect().then(done => { if (done) finish(); }).catch(finish);
  });
} finally {
  worker.kill("SIGTERM");
  await Promise.race([new Promise(resolveExit => worker.once("exit", resolveExit)), delay(5000)]);
  await new Promise<void>(resolveClose => model.close(() => resolveClose()));
  await pool.end();
}
