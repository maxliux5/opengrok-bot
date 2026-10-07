import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBot, createModelProfile, createRoutine, defaultRunBudget,
  dispatchPendingOccurrences, getRun, latestRoutineFire, listRoutineOccurrences,
  migrate, pool, query, reserveDueRoutines, setupOwner } from "../packages/core/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const databaseName = process.env.OPENGROK_ROUTINE_FAILURE_DB_NAME ||
  "opengrok_routine_failure_20261006";
assert.match(databaseName, /^opengrok_routine_failure_\d{8}(?:_[a-z])?$/);
const dataDir = resolve(root, `.local/${databaseName}`);
const hostToken = randomUUID();
const sessionId = randomUUID();
const children: ChildProcess[] = [];
const servers: Array<HttpServer | TcpServer> = [];
const logs: string[] = [];
let runtimeCalls = 0;

assert.equal(resolve(process.env.OPENGROK_DATA_DIR || ""), dataDir,
  "site-failure test requires its own data directory");
assert.equal((await query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name,
  databaseName, "refusing non-isolated DB");

async function listen(server: HttpServer | TcpServer, port: number) {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  servers.push(server);
}

function start(script: string) {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: root,
    env: { ...process.env, OPENGROK_DATA_DIR: dataDir,
      OPENGROK_HOST_URL: "http://127.0.0.1:3888", OPENGROK_HOST_PORT: "3888",
      OPENGROK_HOST_TOKEN: hostToken, OPENGROK_RUNTIME_URL: "http://127.0.0.1:3887",
      OPENGROK_VNC_PORT: "6090", OPENGROK_DESKTOP_MANAGED: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", chunk => logs.push(String(chunk)));
  child.stderr?.on("data", chunk => logs.push(String(chunk)));
  children.push(child);
  return child;
}

async function waitFor(predicate: () => Promise<boolean>, name: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error(`timed out waiting for ${name}\n${logs.slice(-20).join("")}`);
}

try {
  await migrate();
  const users = await query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
  assert.equal(users.rows[0].count, "0", "test database must be fresh");
  const owner = await setupOwner("routine-failure", `routine-${randomUUID()}-password`);
  const profile = await createModelProfile(owner.id, {
    name: "Site failure fixture", provider: "openai-compatible", modelId: "site-failure-fixture",
    baseUrl: "http://127.0.0.1:3892/v1",
    capabilities: { text: true, tools: true, vision: false, streaming: false },
  });
  const bot = await createBot(owner.id, {
    name: "Site failure Bot", description: "", instructions: "", modelProfileId: profile.id,
    capabilities: ["public_web", "artifact"],
  });
  const now = new Date();
  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).format(new Date(now.getTime() - 120_000));
  const routine = await createRoutine(owner.id, {
    botId: bot.id, name: "网站失效回归", timeZone: "Asia/Shanghai", localTime,
    inputText: "读取测试网站并发布带来源的报告", deliverable: "report", skillId: null,
    budget: { ...defaultRunBudget, maxModelSteps: 4, maxToolCalls: 4, maxTokens: 4000 },
  });
  const due = latestRoutineFire(localTime, "Asia/Shanghai", now);
  await query("UPDATE routines SET next_fire_at=$2 WHERE id=$1", [routine.id, due]);

  const model = createHttpServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end(); return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const hasToolResult = input.messages.some((message: { role: string }) => message.role === "tool");
    const message = hasToolResult
      ? { role: "assistant", content: "网站不可访问，无法核对来源和发布报告。" }
      : { role: "assistant", content: null, tool_calls: [{ id: "call_open", type: "function",
        function: { name: "browser_open", arguments: JSON.stringify({ url: "https://example.com/" }) } }] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000),
      model: input.model, choices: [{ index: 0, message,
        finish_reason: hasToolResult ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    }));
  });
  await listen(model, 3892);
  const runtime = createHttpServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ready: true, mode: "agent", busy: false, sessionId, generation: 1,
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/operation") {
      runtimeCalls++;
      response.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify({
        error: "站点不可访问：模拟上游 DNS 故障",
      }));
      return;
    }
    response.writeHead(404).end();
  });
  await listen(runtime, 3887);
  await listen(createTcpServer(socket => socket.end()), 6090);
  start("apps/computer-host/src/index.ts");
  await waitFor(async () => {
    try {
      const response = await fetch("http://127.0.0.1:3888/health", {
        headers: { authorization: `Bearer ${hostToken}` }, signal: AbortSignal.timeout(500),
      });
      return response.ok && (await response.json()).ready === true;
    } catch { return false; }
  }, "fixture host", 10_000);
  assert.equal(await reserveDueRoutines(now), 1);
  assert.equal(await reserveDueRoutines(now), 0);
  assert.equal(await dispatchPendingOccurrences(), 1);
  const occurrence = (await listRoutineOccurrences(owner.id, routine.id))[0];
  assert.equal(occurrence.trigger, "scheduled");
  assert.equal(occurrence.status, "submitted");
  assert.ok(occurrence.runId);
  start("apps/worker/src/index.ts");
  await waitFor(async () => (await getRun(owner.id, occurrence.runId!)).status === "failed",
    "site-failure Run");
  const run = await getRun(owner.id, occurrence.runId);
  assert.equal(run.status, "failed");
  assert.match(run.error || "", /报告未发布.*网页操作失败.*站点不可访问/);
  const history = (await listRoutineOccurrences(owner.id, routine.id))[0];
  assert.equal(history.runStatus, "failed");
  assert.equal(history.error, run.error, "routine history must show Run failure reason");
  const calls = await query<{ status: string; result: { error: string } }>(
    "SELECT status,result FROM tool_calls WHERE run_id=$1 AND name='browser_open'", [run.id]);
  assert.equal(calls.rows.length, 1);
  assert.equal(calls.rows[0].status, "failed");
  assert.match(calls.rows[0].result.error, /站点不可访问/);
  assert.equal(runtimeCalls, 1, "failed site operation was repeated");
  const stored = await query<{ count: string; next_fire_at: Date; active_run_id: string | null }>(
    `SELECT (SELECT COUNT(*)::text FROM routine_occurrences WHERE routine_id=$1
       AND trigger='scheduled') AS count,r.next_fire_at,s.active_run_id
     FROM routines r JOIN bot_execution_slots s ON s.bot_id=r.bot_id WHERE r.id=$1`, [routine.id]);
  assert.equal(stored.rows[0].count, "1");
  assert.ok(stored.rows[0].next_fire_at.getTime() > now.getTime(),
    "tomorrow's trigger was lost after the failure");
  assert.equal(stored.rows[0].active_run_id, null);
  const journal = new DatabaseSync(resolve(dataDir, "host-journal.sqlite"), { readOnly: true });
  const receipts = journal.prepare("SELECT status FROM operations").all() as Array<{ status: string }>;
  journal.close();
  assert.deepEqual(receipts.map(item => item.status), ["failed"]);
  console.log(JSON.stringify({ routineId: routine.id, runId: run.id, runStatus: run.status,
    routineError: history.error, toolError: calls.rows[0].result.error,
    physicalAttempts: runtimeCalls, nextFireAt: stored.rows[0].next_fire_at.toISOString() }));
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null
    ? new Promise<void>(done => {
      child.once("exit", () => done());
      setTimeout(() => { child.kill("SIGKILL"); done(); }, 3000).unref();
    }) : Promise.resolve()));
  for (const server of servers.reverse()) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
  await pool.end();
}
