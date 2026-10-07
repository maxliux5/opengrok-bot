import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { canonicalJson } from "../packages/contracts/src/index.ts";
import { createBot, createConversation, createModelProfile, getRun,
  migrate, pool, query, setupOwner, submitMessage } from "../packages/core/src/index.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sessionId = randomUUID();
const hostToken = randomUUID();
const databaseName = process.env.OPENGROK_PARALLEL_DB_NAME || "opengrok_parallel_20261006";
const hostDataDir = `.local/${databaseName}-host`;
const databaseUrl = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : new URL(`postgresql:///${databaseName}`);
databaseUrl.pathname = `/${databaseName}`;
if (!process.env.DATABASE_URL) {
  databaseUrl.searchParams.set("host", resolve(import.meta.dirname, "../.local"));
  databaseUrl.searchParams.set("port", process.env.OPENGROK_DB_PORT || "55432");
}
const childEnv = { ...process.env, DATABASE_URL: databaseUrl.toString(),
  OPENGROK_DATA_DIR: hostDataDir,
  OPENGROK_HOST_URL: "http://127.0.0.1:3884",
  OPENGROK_HOST_PORT: "3884", OPENGROK_HOST_TOKEN: hostToken,
  OPENGROK_RUNTIME_URL: "http://127.0.0.1:3883", OPENGROK_VNC_PORT: "6088",
  OPENGROK_DESKTOP_MANAGED: "0" };
const children: ChildProcess[] = [];
const servers: Array<HttpServer | TcpServer> = [];
const logs: string[] = [];
let modelActive = 0;
let maxModelActive = 0;
let runtimeActive = 0;
let maxRuntimeActive = 0;
let runtimeDelayMs = 1200;
const runtimeRanges: Array<{ start: number; end: number }> = [];

function start(script: string) {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: process.cwd(), env: childEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", chunk => logs.push(String(chunk)));
  child.stderr?.on("data", chunk => logs.push(String(chunk)));
  children.push(child);
  return child;
}

async function listen(server: HttpServer | TcpServer, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  servers.push(server);
}

async function waitFor(predicate: () => Promise<boolean>, name: string, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${name}\n${logs.slice(-20).join("")}`);
}

try {
  const db = await query<{ name: string }>("SELECT current_database() AS name");
  assert.match(databaseName, /^opengrok_parallel_\d{8}(?:_[a-z])?$/);
  assert.equal(db.rows[0].name, databaseName, "refusing non-isolated DB");
  await migrate();
  const owner = await setupOwner("parallel_smoke", `parallel-${randomUUID()}-password`);
  const profile = await createModelProfile(owner.id, {
    name: "Parallel fixture", provider: "openai-compatible", modelId: "parallel-fixture",
    baseUrl: "http://127.0.0.1:3890/v1",
    capabilities: { text: true, tools: true, vision: false, streaming: false },
  });
  const runIds: string[] = [];
  const botIds: string[] = [];
  for (const name of ["Parallel A", "Parallel B"]) {
    const bot = await createBot(owner.id, {
      name, description: "", instructions: "", modelProfileId: profile.id,
      capabilities: ["public_web"],
    });
    const conversation = await createConversation(owner.id, bot.id);
    botIds.push(bot.id);
    const { run } = await submitMessage(owner.id, conversation.id, {
      text: "打开并观察一个公开测试页面", requestId: randomUUID(), deliverable: "answer",
    });
    runIds.push(run.id);
  }

  const model = createHttpServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end(); return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    modelActive++;
    maxModelActive = Math.max(maxModelActive, modelActive);
    try {
      await sleep(1600);
      const used = input.messages.some((message: { role: string }) => message.role === "tool");
      const message = used ? { role: "assistant", content: "已观察页面。" } : {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_open", type: "function", function: {
          name: "browser_open", arguments: JSON.stringify({ url: "https://example.com/" }),
        } }],
      };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model: input.model, choices: [{ index: 0, message,
          finish_reason: used ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      }));
    } finally { modelActive--; }
  });
  await listen(model, 3890);
  const runtime = createHttpServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ready: true, mode: "agent", busy: runtimeActive > 0, sessionId, generation: 1,
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/operation") {
      response.writeHead(404).end(); return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const range = { start: Date.now(), end: 0 };
    runtimeRanges.push(range);
    runtimeActive++;
    maxRuntimeActive = Math.max(maxRuntimeActive, runtimeActive);
    try {
      await sleep(runtimeDelayMs);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        url: input.args.url, title: "Example Domain fixture", sessionId,
      }));
    } finally { range.end = Date.now(); runtimeActive--; }
  });
  await listen(runtime, 3883);
  await listen(createTcpServer(socket => socket.end()), 6088);
  const host = start("apps/computer-host/src/index.ts");
  await waitFor(async () => {
    try {
      const response = await fetch("http://127.0.0.1:3884/health", {
        headers: { authorization: `Bearer ${hostToken}` }, signal: AbortSignal.timeout(500),
      });
      return response.ok && (await response.json()).ready === true;
    } catch { return false; }
  }, "test host", 10_000);
  const workers = [start("apps/worker/src/index.ts"), start("apps/worker/src/index.ts")];
  await waitFor(async () => (await Promise.all(runIds.map(id => getRun(owner.id, id))))
    .every(run => ["succeeded", "failed"].includes(run.status)), "both Runs");
  const runs = await Promise.all(runIds.map(id => getRun(owner.id, id)));
  assert.deepEqual(runs.map(run => run.status), ["succeeded", "succeeded"],
    JSON.stringify(runs.map(run => run.error)));
  const steps = await query<{ run_id: string; created_at: Date; completed_at: Date }>(
    `SELECT run_id,created_at,completed_at FROM model_steps
     WHERE run_id=ANY($1::uuid[]) AND ordinal=1`, [runIds]);
  assert.equal(steps.rows.length, 2);
  assert.ok(steps.rows[0].created_at < steps.rows[1].completed_at &&
    steps.rows[1].created_at < steps.rows[0].completed_at, "model calls did not overlap");
  assert.ok(maxModelActive >= 2, "model server observed no concurrent inference");
  assert.equal(runtimeRanges.length, 2);
  assert.equal(maxRuntimeActive, 1, "desktop runtime received overlapping operations");
  const ordered = [...runtimeRanges].sort((a, b) => a.start - b.start);
  assert.ok(ordered[1].start >= ordered[0].end, "desktop operations overlapped");
  const calls = await query<{ run_id: string; status: string }>(
    "SELECT run_id,status FROM tool_calls WHERE run_id=ANY($1::uuid[]) AND name='browser_open'",
    [runIds]);
  assert.equal(calls.rows.length, 2);
  assert.ok(calls.rows.every(call => call.status === "succeeded"));
  const journalPath = join(process.cwd(), hostDataDir, "host-journal.sqlite");
  const journal = new DatabaseSync(journalPath,
    { readOnly: true });
  const receipts = journal.prepare("SELECT status FROM operations").all() as Array<{ status: string }>;
  journal.close();
  assert.deepEqual(receipts.map(item => item.status).sort(), ["succeeded", "succeeded"]);
  for (const worker of workers) worker.kill("SIGTERM");
  await Promise.all(workers.map(worker => new Promise<void>(resolve => worker.once("exit", () => resolve()))));

  async function stagedOperation(botId: string) {
    const conversation = await createConversation(owner.id, botId);
    const { run } = await submitMessage(owner.id, conversation.id, {
      text: "Host 排队重启测试", requestId: randomUUID(), deliverable: "answer",
    });
    await query(`UPDATE runs SET status='running',lease_owner='queue-restart-fixture',
      lease_epoch=1,lease_until=now()+interval '2 minutes' WHERE id=$1`, [run.id]);
    await query("UPDATE bot_execution_slots SET active_run_id=$2 WHERE bot_id=$1", [botId, run.id]);
    const stepId = randomUUID();
    await query(`INSERT INTO model_steps(id,run_id,ordinal,input_revision,model_profile_id,
      status,input_snapshot,output_snapshot)
      VALUES ($1,$2,1,1,$3,'completed','[]'::jsonb,'{}'::jsonb)`, [stepId, run.id, profile.id]);
    const args = { url: "https://example.com/" };
    const argsHash = createHash("sha256").update(canonicalJson(args)).digest("hex");
    const operationId = randomUUID();
    await query(`INSERT INTO tool_calls(id,run_id,step_id,operation_id,ordinal,name,args,args_hash,
      status,replay_policy)
      VALUES ($1,$2,$3,$4,0,'browser_open',$5,$6,'dispatching','reconcile_before_retry')`,
    [randomUUID(), run.id, stepId, operationId, JSON.stringify(args), argsHash]);
    return { operationId, runId: run.id, epoch: 1, name: "browser_open", args, argsHash };
  }
  const first = await stagedOperation(botIds[0]);
  const second = await stagedOperation(botIds[1]);
  const access = await fetch("http://127.0.0.1:3884/health", {
    headers: { authorization: `Bearer ${hostToken}` },
  }).then(response => response.json() as Promise<{ controlEpoch: number }>);
  runtimeDelayMs = 4000;
  function sendOperation(input: typeof first) {
    return fetch("http://127.0.0.1:3884/operations", {
      method: "POST", headers: { authorization: `Bearer ${hostToken}`,
        "content-type": "application/json" },
      body: JSON.stringify({ ...input, controlEpoch: access.controlEpoch,
        deadline: Date.now() + 20_000 }),
    }).then(response => response.json(), error => ({ error: String(error) }));
  }
  function journalStatus(operationId: string) {
    const db = new DatabaseSync(journalPath, { readOnly: true });
    try { return (db.prepare("SELECT status FROM operations WHERE operation_id=?")
      .get(operationId) as { status: string } | undefined)?.status; }
    finally { db.close(); }
  }
  const firstRequest = sendOperation(first);
  await waitFor(async () => journalStatus(first.operationId) === "dispatching" && runtimeActive === 1,
    "first operation dispatch");
  const secondRequest = sendOperation(second);
  await waitFor(async () => journalStatus(second.operationId) === "received",
    "second operation queued");
  host.kill("SIGKILL");
  await new Promise<void>(resolve => host.once("exit", () => resolve()));
  await Promise.all([firstRequest, secondRequest]);
  start("apps/computer-host/src/index.ts");
  await waitFor(async () => journalStatus(first.operationId) === "unknown" &&
    journalStatus(second.operationId) === "failed", "queued receipt recovery", 10_000);
  await waitFor(async () => runtimeActive === 0, "orphaned fixture runtime operation", 10_000);
  assert.equal(runtimeRanges.length, 3, "queued operation reached the runtime after host restart");
  const secondReceipt = await fetch(`http://127.0.0.1:3884/receipts/${second.operationId}`, {
    headers: { authorization: `Bearer ${hostToken}` },
  }).then(response => response.json() as Promise<{ outcome: string; result: { error: string } }>);
  assert.equal(secondReceipt.outcome, "failed");
  assert.match(secondReceipt.result.error, /尚未派发/);
  console.log(JSON.stringify({ runIds, maxModelActive, maxRuntimeActive,
    runtimeRanges: ordered, successfulReceipts: receipts.length,
    interruptedReceipt: journalStatus(first.operationId),
    queuedReceipt: secondReceipt.outcome, physicalOperationsAfterRestart: runtimeRanges.length }));
} finally {
  for (const child of children.reverse()) child.kill("SIGTERM");
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? new Promise<void>(resolve => {
    child.once("exit", () => resolve());
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000).unref();
  }) : Promise.resolve()));
  for (const server of servers.reverse()) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await pool.end();
}
