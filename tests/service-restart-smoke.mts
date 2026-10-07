import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, constants, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { connect } from "node:net";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { finishRun, heartbeat, latestRoutineFire, migrate, pool, query,
  reserveDueRoutines } from "../packages/core/src/index.ts";

assert.equal(process.env.OPENGROK_ALLOW_DESKTOP_RESTART_TEST, "1",
  "Set OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1 before recreating the desktop");
const root = resolve(import.meta.dirname, "..");
const dataDir = resolve(process.env.OPENGROK_DATA_DIR || "");
assert.ok(dataDir.startsWith(join(root, ".local") + "/") && basename(dataDir).startsWith("restart-"),
  "Use a dedicated .local/restart-* data directory");
const database = (await query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name;
assert.match(database || "", /^opengrok_restart_[a-z0-9_]+$/, "Use a dedicated restart-test database");
await migrate();
assert.equal((await query<{ count: string }>("SELECT count(*)::text AS count FROM users")).rows[0]?.count,
  "0", "The restart-test database must be unused");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
copyFileSync(join(root, ".local/desktop.env"), join(dataDir, "desktop.env"), constants.COPYFILE_EXCL);
const token = readFileSync(join(root, ".local/host.token"), "utf8").trim();
const hostHeaders = { authorization: `Bearer ${token}` };
const env = { ...process.env, OPENGROK_DATA_DIR: dataDir, OPENGROK_HOST_TOKEN: token,
  OPENGROK_HOST_URL: "http://127.0.0.1:3844", OPENGROK_DESKTOP_MANAGED: "0" };
const apiBase = "http://127.0.0.1:3841/api";
const children = new Map<string, ChildProcess>();
let cookie = "";

function start(name: string, command: string, args: string[], extra: Record<string, string> = {}) {
  const fd = openSync(join(dataDir, `${name}.log`), "a", 0o600);
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extra },
    detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  children.set(name, child);
  return child;
}

async function stop(name: string, signal: NodeJS.Signals = "SIGTERM") {
  const child = children.get(name);
  children.delete(name);
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already stopped */ }
  }
}

async function waitFor<T>(label: string, timeoutMs: number, check: () => Promise<T | null | false>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function healthy(url: string, headers: Record<string, string> = {}) {
  try { return (await fetch(url, { headers, signal: AbortSignal.timeout(2000) })).ok; }
  catch { return false; }
}

async function portOpen(port: number) {
  return new Promise<boolean>(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${apiBase}${path}`, { method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function hostState(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/state`, { headers: hostHeaders,
    signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  return (await response.json()).computer as {
    status: string; controlMode: string; operationBusy: boolean; sessionId: string; generation: number;
  };
}

async function eventCount(runId: string, kind: string) {
  const result = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM run_events WHERE run_id=$1 AND kind=$2", [runId, kind]);
  return Number(result.rows[0]?.count || 0);
}

async function latestSequence(runId: string) {
  const result = await query<{ sequence: string }>(
    "SELECT coalesce(max(sequence),0)::text AS sequence FROM run_events WHERE run_id=$1", [runId]);
  return Number(result.rows[0].sequence);
}

async function submit(botId: string, text: string) {
  const { conversation } = await api(`/bots/${botId}/conversations`, "POST", {});
  const { run } = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text, requestId: randomUUID(), deliverable: "report",
  });
  return run.id as string;
}

async function completedReport(runId: string) {
  const run = await waitFor(`Run ${runId}`, 90_000, async () => {
    const current = (await api(`/runs/${runId}`)).run;
    return ["succeeded", "failed", "canceled"].includes(current.status) ? current : null;
  });
  assert.equal(run.status, "succeeded", `Run ${runId}: ${run.error || run.status}`);
  const { artifacts } = await api(`/runs/${runId}/artifacts`);
  assert.equal(artifacts.length, 1);
  const response = await fetch(`${apiBase}/artifacts/${artifacts[0].id}/content`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /https:\/\/example\.com\//);
  return artifacts[0].id as string;
}

async function sseHasSuccess(runId: string, after: number) {
  const response = await fetch(`${apiBase}/runs/${runId}/events?after=${after}`, {
    headers: { cookie }, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() || "";
      for (const frame of frames) {
        const line = frame.split("\n").find(item => item.startsWith("data: "));
        if (line && JSON.parse(line.slice(6)).kind === "succeeded") return true;
      }
    }
  } finally { await reader.cancel(); }
}

const tsx = join(root, "node_modules/.bin/tsx");
const source = (name: string) => join(root, `apps/${name}/src/index.ts`);
try {
  assert.equal(await healthy("http://127.0.0.1:3842/health", hostHeaders), true,
    "The managed desktop Host must be online");
  const formal = await hostState(3842);
  assert.equal(formal.status, "ready");
  assert.equal(formal.controlMode, "agent");
  assert.equal(formal.operationBusy, false);
  assert.equal((await fetch("http://127.0.0.1:3848/api/bootstrap").then(r => r.json())).initialized,
    false, "The managed workspace must have no active owner before desktop rebuild");
  for (const port of [3841, 3844, 3850]) {
    assert.equal(await portOpen(port), false, `Port ${port} is already in use`);
  }

  start("model", process.execPath, [join(root, "tests/fake-model.mjs")]);
  start("host", tsx, [source("computer-host")], { OPENGROK_HOST_PORT: "3844" });
  start("api", tsx, [source("api")], { OPENGROK_API_PORT: "3841" });
  await waitFor("model", 20_000, async () => {
    try { await fetch("http://127.0.0.1:3850/", { signal: AbortSignal.timeout(2000) }); return true; }
    catch { return false; }
  });
  await waitFor("isolated Host", 20_000, () => healthy("http://127.0.0.1:3844/health", hostHeaders));
  await waitFor("isolated API", 20_000, () => healthy(`${apiBase}/health`));
  const state = await hostState(3844);
  assert.equal(state.status, "ready");
  assert.equal(state.controlMode, "agent");

  assert.equal((await api("/bootstrap")).initialized, false);
  await api("/setup", "POST", { username: "restart-smoke", password: randomBytes(24).toString("base64url") });
  const sessionHash = createHash("sha256").update(cookie.split("=", 2)[1]).digest("hex");
  assert.equal((await query("SELECT 1 FROM sessions WHERE token_hash=$1", [sessionHash])).rowCount, 1,
    "The API is not connected to the isolated database");
  const { profile } = await api("/model-profiles", "POST", { name: "Restart test model",
    provider: "openai-compatible", modelId: "test-model", baseUrl: "http://127.0.0.1:3850/v1" });
  const { bots } = await api("/bots");
  assert.equal(bots.length, 1);
  const { bot } = await api(`/bots/${bots[0].id}`, "PATCH", {
    modelProfileId: profile.id, expectedRevision: bots[0].revision,
  });
  start("worker", tsx, [source("worker")]);
  await waitFor("worker heartbeat", 20_000, async () => {
    const result = await query("SELECT 1 FROM service_heartbeats WHERE service_name='worker' LIMIT 1");
    return result.rowCount > 0;
  });

  const apiRun = await submit(bot.id, "服务重启验证：研究 Example Domain 并生成报告");
  await waitFor("started model step", 15_000, async () => await eventCount(apiRun, "model_step_started") > 0);
  await stop("api", "SIGKILL");
  assert.equal(await healthy(`${apiBase}/health`), false);
  const apiStopSequence = await latestSequence(apiRun);
  await waitFor("Worker progress while API is down", 15_000,
    async () => await eventCount(apiRun, "model_step_completed") > 0);
  assert.equal(await healthy(`${apiBase}/health`), false);
  start("api", tsx, [source("api")], { OPENGROK_API_PORT: "3841" });
  await waitFor("restarted API", 20_000, () => healthy(`${apiBase}/health`));
  const apiArtifact = await completedReport(apiRun);
  assert.equal(await sseHasSuccess(apiRun, apiStopSequence), true);

  await stop("host");
  start("host", tsx, [source("computer-host")], {
    OPENGROK_HOST_PORT: "3844", OPENGROK_TEST_DROP_AFTER_RECEIPT: "browser_open",
  });
  await waitFor("fault-injection Host", 20_000, () => healthy("http://127.0.0.1:3844/health", hostHeaders));
  const workerRun = await submit(bot.id, "研究 Example Domain 并生成报告");
  await waitFor("unknown browser result", 20_000, async () => await eventCount(workerRun, "tool_unknown") > 0);
  const old = (await query<{ worker_id: string; lease_epoch: string }>(
    `SELECT e.payload->>'workerId' AS worker_id,r.lease_epoch::text
     FROM runs r JOIN run_events e ON e.run_id=r.id AND e.kind='running'
     WHERE r.id=$1 ORDER BY e.sequence LIMIT 1`, [workerRun])).rows[0];
  assert.ok(old.worker_id);
  assert.equal(await eventCount(workerRun, "tool_reconciled"), 0,
    "The old Worker reconciled before the crash test could stop it");
  await stop("worker", "SIGKILL");
  start("worker", tsx, [source("worker")]);
  const workerArtifact = await completedReport(workerRun);
  assert.equal(await eventCount(workerRun, "tool_unknown"), 1);
  assert.equal(await eventCount(workerRun, "tool_reconciled"), 1);
  assert.equal(await heartbeat(workerRun, old.worker_id, Number(old.lease_epoch)), false);
  assert.equal(await finishRun(workerRun, old.worker_id, Number(old.lease_epoch), 1, "stale"), "lost");
  const journal = new DatabaseSync(join(dataDir, "host-journal.sqlite"), { readOnly: true });
  const physicalOpens = (journal.prepare(
    "SELECT count(*) AS count FROM operations WHERE run_id=? AND name='browser_open'",
  ).get(workerRun) as { count: number }).count;
  journal.close();
  assert.equal(physicalOpens, 1);

  const beforeDesktop = await hostState(3842);
  assert.equal(beforeDesktop.status, "ready");
  assert.equal(beforeDesktop.controlMode, "agent");
  assert.equal(beforeDesktop.operationBusy, false);
  const restart = await fetch("http://127.0.0.1:3842/restart", {
    method: "POST", headers: hostHeaders, signal: AbortSignal.timeout(10_000),
  });
  assert.equal(restart.status, 200, await restart.text());
  const afterDesktop = await waitFor("new desktop session", 120_000, async () => {
    const current = await hostState(3842);
    return current.status === "ready" && current.controlMode === "agent" &&
      current.sessionId !== beforeDesktop.sessionId ? current : null;
  });
  assert.ok(afterDesktop.generation > beforeDesktop.generation);
  await waitFor("isolated Host sees new desktop", 20_000, async () => {
    const current = await hostState(3844);
    return current.status === "ready" && current.sessionId === afterDesktop.sessionId;
  });
  const desktopRun = await submit(bot.id, "研究 Example Domain 并生成报告");
  const desktopArtifact = await completedReport(desktopRun);

  await stop("worker", "SIGKILL");
  const { budget } = await api("/routines/defaults");
  const { routine } = await api("/routines", "POST", {
    botId: bot.id, name: "重启后每日研究", timeZone: "Asia/Shanghai", localTime: "09:30",
    inputText: "服务重启验证：研究 Example Domain 并生成报告",
    deliverable: "report", budget, skillId: null,
  });
  const scheduledAt = latestRoutineFire(routine.localTime, routine.timeZone, new Date());
  await query("UPDATE routines SET next_fire_at=$2 WHERE id=$1", [routine.id, scheduledAt]);
  assert.equal(await reserveDueRoutines(), 1);
  assert.equal(await reserveDueRoutines(), 0);
  const pending = (await query<{ id: string; request_id: string; status: string }>(
    "SELECT id,request_id,status FROM routine_occurrences WHERE routine_id=$1", [routine.id])).rows;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");

  start("worker", tsx, [source("worker")]);
  const submitted = await waitFor("scheduled routine submission", 20_000, async () => {
    const rows = (await query<{ run_id: string | null; status: string }>(
      "SELECT run_id,status FROM routine_occurrences WHERE id=$1", [pending[0].id])).rows;
    return rows[0]?.status === "submitted" && rows[0].run_id ? rows[0].run_id : null;
  });
  await waitFor("routine model step", 20_000,
    async () => await eventCount(submitted, "model_step_started") > 0);
  await stop("worker", "SIGKILL");
  start("worker", tsx, [source("worker")]);
  const routineArtifact = await completedReport(submitted);
  const finalOccurrences = (await query<{ id: string; request_id: string; run_id: string;
    status: string; scheduled_at: Date }>(
    "SELECT id,request_id,run_id,status,scheduled_at FROM routine_occurrences WHERE routine_id=$1",
    [routine.id])).rows;
  assert.equal(finalOccurrences.length, 1);
  assert.equal(finalOccurrences[0].id, pending[0].id);
  assert.equal(finalOccurrences[0].request_id, pending[0].request_id);
  assert.equal(finalOccurrences[0].run_id, submitted);
  assert.equal(finalOccurrences[0].status, "submitted");
  assert.equal(finalOccurrences[0].scheduled_at.toISOString(), scheduledAt.toISOString());
  assert.equal(await eventCount(submitted, "routine_triggered"), 1);
  assert.equal(await eventCount(submitted, "queued"), 1);
  assert.equal(await eventCount(submitted, "running"), 2);
  assert.equal(await eventCount(submitted, "model_step_interrupted"), 1);
  const routineEpoch = (await query<{ lease_epoch: string }>(
    "SELECT lease_epoch::text FROM runs WHERE id=$1", [submitted])).rows[0];
  assert.equal(Number(routineEpoch.lease_epoch), 2);
  const routineNavigations = (await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM tool_calls WHERE run_id=$1 AND name='browser_open'",
    [submitted])).rows[0];
  assert.equal(Number(routineNavigations.count), 1);
  assert.equal(await reserveDueRoutines(), 0);
  console.log(JSON.stringify({ database, apiRun, apiArtifact, apiStopSequence,
    workerRun, workerArtifact, oldWorker: old.worker_id, oldEpoch: Number(old.lease_epoch),
    unknown: 1, reconciled: 1, physicalOpens,
    desktopRun, desktopArtifact, desktopSessionChanged: true,
    desktopGeneration: [beforeDesktop.generation, afterDesktop.generation],
    routineId: routine.id, routineOccurrenceId: pending[0].id,
    routineRun: submitted, routineArtifact, scheduledCount: finalOccurrences.length,
    routineEpoch: Number(routineEpoch.lease_epoch), routineNavigations: Number(routineNavigations.count) }));
} finally {
  for (const name of [...children.keys()].reverse()) await stop(name).catch(() => undefined);
  await pool.end();
}
