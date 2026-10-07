import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { z } from "zod";
import { canonicalJson } from "@opengrok/contracts";
import { approvalRequiredTools, artifactDir, computerToolNames, dataDir, hostToken, projectRoot,
  query, toolInputSchemas, toolRegistry } from "@opengrok/core";

const exec = promisify(execFile);
const app = Fastify({ logger: true, bodyLimit: 128_000 });
const runtimeUrl = new URL(process.env.OPENGROK_RUNTIME_URL || "http://127.0.0.1:3843");
const vncPort = Number(process.env.OPENGROK_VNC_PORT || 6080);
if (runtimeUrl.protocol !== "http:" || runtimeUrl.hostname !== "127.0.0.1" ||
  runtimeUrl.pathname !== "/" || !Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535) {
  throw new Error("Desktop runtime 和 VNC 必须配置为本机 HTTP/端口");
}
const journal = new DatabaseSync(join(dataDir, "host-journal.sqlite"));
journal.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS operations (
    operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    args_hash TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
    result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS control (
    id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, control_id TEXT,
    expires_at INTEGER
  );
  INSERT OR IGNORE INTO control(id,mode) VALUES (1,'agent');
  UPDATE operations SET status='failed',result_json='{"error":"电脑操作尚未派发，host 已重启"}',
    updated_at=datetime('now') WHERE status='received';
  UPDATE operations SET status='unknown',updated_at=datetime('now')
    WHERE status='dispatching';`);
const controlColumns = journal.prepare("PRAGMA table_info(control)").all() as Array<{ name: string }>;
for (const [name, type] of [
  ["last_session_id", "TEXT"], ["generation", "INTEGER NOT NULL DEFAULT 0"],
  ["control_epoch", "INTEGER NOT NULL DEFAULT 1"], ["target_mode", "TEXT"],
]) {
  if (!controlColumns.some(column => column.name === name)) journal.exec(`ALTER TABLE control ADD COLUMN ${name} ${type}`);
}
const oldControl = journal.prepare("SELECT mode FROM control WHERE id=1").get() as { mode: string };
if (oldControl.mode !== "agent" && oldControl.mode !== "restarting") journal.prepare(
  "UPDATE control SET mode='handing_off',target_mode='agent',control_id=NULL,expires_at=NULL,control_epoch=control_epoch+1 WHERE id=1",
).run();

const runtimeTokenPath = join(dataDir, "desktop.env");
try {
  writeFileSync(runtimeTokenPath, `OPENGROK_RUNTIME_TOKEN=${randomBytes(32).toString("base64url")}\n`,
    { flag: "wx", mode: 0o600 });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const runtimeToken = readFileSync(runtimeTokenPath, "utf8").trim().split("=", 2)[1];
if (!runtimeToken) throw new Error("Invalid desktop runtime token");

type OperationRow = {
  operation_id: string; run_id: string; epoch: number; args_hash: string;
  name: string; status: "received" | "dispatching" | "succeeded" | "failed" | "unknown";
  result_json: string | null;
};
type ControlRow = { mode: "agent" | "human" | "handing_off" | "restarting"; control_id: string | null;
  target_mode: "agent" | "human" | null; expires_at: number | null;
  last_session_id: string | null; generation: number; control_epoch: number };
const operation = journal.prepare("SELECT * FROM operations WHERE operation_id=?");
const control = journal.prepare("SELECT * FROM control WHERE id=1");
let startup: Promise<void> | null = null;
let startupError: string | null = null;
let restart: Promise<void> | null = null;
let restartError: string | null = null;
let handoff: Promise<void> | null = null;
let busy = false;
let faultDropped = false;
let operationTail: Promise<void> = Promise.resolve();

async function acquireOperationSlot(): Promise<() => void> {
  const previous = operationTail;
  let release!: () => void;
  operationTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  return release;
}

async function compose(args: string[], timeout: number) {
  const compose = join(projectRoot, "infra/desktop/compose.yaml");
  await exec("sudo", ["-n", process.execPath, join(projectRoot, "scripts/desktop-firewall.mjs"),
    "verify", "desktop_default", process.env.OPENGROK_EGRESS_PORT || "3888"],
  { cwd: projectRoot, timeout: 10_000 });
  const dockerConfig = process.env.OPENGROK_DOCKER_CONFIG || join(process.env.HOME || "", ".docker");
  const command = ["compose", "-f", compose, ...args];
  const options = { cwd: projectRoot, timeout, maxBuffer: 64 * 1024 * 1024 };
  let direct = false;
  try {
    await exec("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 3000 });
    direct = true;
  } catch { /* local account may need the configured sudo path */ }
  if (direct) await exec("docker", command, options);
  else await exec("sudo", ["-n", "env", `DOCKER_CONFIG=${dockerConfig}`,
    `http_proxy=${process.env.http_proxy || ""}`,
    `https_proxy=${process.env.https_proxy || ""}`,
    `no_proxy=${process.env.no_proxy || ""}`,
    `OPENGROK_EGRESS_PORT=${process.env.OPENGROK_EGRESS_PORT || "3888"}`,
    "docker", ...command], options);
}

async function ensureContainer() {
  if (process.env.OPENGROK_DESKTOP_MANAGED === "0") throw new Error("隔离 Host 不管理桌面容器生命周期");
  await compose(["up", "-d", "--build"], 30 * 60_000);
}

async function restartContainer(previousSession: string | null) {
  if (process.env.OPENGROK_DESKTOP_MANAGED === "0") throw new Error("隔离 Host 不管理桌面容器生命周期");
  await compose(["up", "-d", "--force-recreate", "--no-build", "desktop"], 3 * 60_000);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const runtime = await runtimeRequest<{ ready: boolean; mode: string; busy: boolean; sessionId: string }>("/health");
      if (runtime.ready && runtime.mode === "agent" && !runtime.busy &&
        runtime.sessionId !== previousSession) return;
    } catch { /* Desktop is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("重启后未能确认新的桌面会话及 Agent 输入状态");
}

async function bridgeReady(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port: vncPort });
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

class RuntimeHttpError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

async function runtimeRequest<T>(path: string, init: RequestInit = {}, timeoutMs = 4000): Promise<T> {
  const response = await fetch(new URL(path, runtimeUrl), {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${runtimeToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new RuntimeHttpError(body.error || `Desktop runtime HTTP ${response.status}`, response.status);
  return body;
}

async function persistScreenshot(runId: string, operationId: string, result: Record<string, unknown>) {
  if (typeof result.imageBase64 !== "string") throw new Error("Desktop screenshot response is incomplete");
  const content = Buffer.from(result.imageBase64, "base64");
  if (content.length < 24 || content.length > 2_000_000 ||
    !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Desktop screenshot is not a supported PNG");
  }
  const runDir = join(artifactDir, runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, `${operationId}.png`);
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(content)) throw new Error("Screenshot operation ID reused with different bytes");
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  return { url: result.url, title: result.title,
    observationId: result.observationId, sessionId: result.sessionId,
    sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: content.length,
    width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
}

function advanceHandoff(): Promise<void> {
  if (handoff) return handoff;
  const task = (async () => {
    const current = control.get() as ControlRow;
    if (current.mode !== "handing_off" || !current.target_mode || busy ||
      journal.prepare("SELECT 1 FROM operations WHERE status='dispatching' LIMIT 1").get()) return;
    try {
      const result = await runtimeRequest<{ mode: string }>("/control", {
        method: "POST", body: JSON.stringify({ mode: current.target_mode }),
      });
      if (result.mode !== current.target_mode) throw new Error("Desktop control response does not match the requested mode");
      if (current.target_mode === "human") {
        journal.prepare(`UPDATE control SET mode='human',target_mode=NULL,control_id=?,expires_at=?
          WHERE id=1 AND mode='handing_off' AND target_mode='human' AND control_epoch=?`)
          .run(randomUUID(), Date.now() + 10 * 60_000, current.control_epoch);
      } else {
        journal.prepare(`UPDATE control SET mode='agent',target_mode=NULL,control_id=NULL,expires_at=NULL
          WHERE id=1 AND mode='handing_off' AND target_mode='agent' AND control_epoch=?`)
          .run(current.control_epoch);
      }
    } catch (error) {
      if (!(error instanceof RuntimeHttpError && error.statusCode === 409)) {
        app.log.warn(error, "computer control handoff is still pending");
      }
    }
  })();
  handoff = task.finally(() => { handoff = null; });
  return handoff;
}

async function desktopState() {
  let current = control.get() as ControlRow;
  try {
    const runtime = await runtimeRequest<{ ready: boolean; mode: string; busy: boolean; sessionId: string; generation: number }>("/health");
    if (runtime.sessionId !== current.last_session_id) {
      journal.prepare("UPDATE control SET last_session_id=?,generation=generation+1 WHERE id=1")
        .run(runtime.sessionId);
      current = control.get() as ControlRow;
    }
    const consistent = runtime.mode === current.mode;
    const bridge = await bridgeReady();
    return {
      status: current.mode === "restarting" ? restart ? "starting" : "unavailable" :
        runtime.ready && consistent && bridge ? "ready" : "unavailable",
      controlMode: current.mode, controlId: current.control_id,
      operationBusy: busy || runtime.busy || current.mode === "restarting",
      controlEpoch: current.control_epoch, sessionId: runtime.sessionId, generation: current.generation,
      detail: current.mode === "restarting" ? restartError || "电脑重启中" :
        current.mode === "handing_off" ? current.target_mode === "human" ?
          "等待在途电脑操作结束并交接" : "正在归还电脑控制" :
        !consistent ? "电脑控制状态需要核对" : !bridge ? "桌面画面连接不可用" :
        runtime.ready ? undefined : "浏览器或显示服务未就绪",
    };
  } catch (error) {
    return { status: restart ? "starting" : current.mode === "restarting" ? "unavailable" :
      startup ? "starting" : "stopped", controlMode: current.mode,
      controlId: current.control_id, controlEpoch: current.control_epoch,
      operationBusy: true,
      generation: current.generation, detail: restartError || startupError ||
        (error instanceof Error ? error.message : String(error)) };
  }
}

function authorized(header: string | undefined): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(hostToken());
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

app.addHook("onRequest", async (request, reply) => {
  if (!authorized(request.headers.authorization)) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

app.get("/health", async () => {
  const state = await desktopState();
  return { ready: state.status === "ready" && state.controlMode === "agent",
    controlEpoch: state.controlEpoch, generation: state.generation };
});
app.get("/state", async () => ({ computer: await desktopState() }));
app.post("/ensure", async () => {
  if (restart) return { computer: await desktopState() };
  if (!startup) {
    startupError = null;
    startup = ensureContainer().catch(error => {
      startupError = error instanceof Error ? error.message : String(error);
      app.log.error(error, "desktop start failed");
    }).finally(() => { startup = null; });
  }
  return { computer: await desktopState() };
});

app.post("/restart", async (_request, reply) => {
  if (startup) return reply.code(409).send({ error: "Computer startup is in progress" });
  if (restart) return { computer: await desktopState() };
  const previous = control.get() as ControlRow;
  restartError = null;
  journal.prepare(`UPDATE control SET mode='restarting',control_id=NULL,expires_at=NULL,
    target_mode=NULL,control_epoch=control_epoch+1 WHERE id=1`).run();
  journal.prepare(`UPDATE operations SET status='unknown',updated_at=? WHERE status='dispatching'`)
    .run(new Date().toISOString());
  restart = restartContainer(previous.last_session_id).then(async () => {
    journal.prepare("UPDATE control SET mode='agent',control_id=NULL,expires_at=NULL WHERE id=1").run();
    await desktopState();
  }).catch(error => {
    restartError = error instanceof Error ? error.message : String(error);
    app.log.error(error, "desktop restart failed");
  }).finally(() => { restart = null; });
  return { computer: await desktopState() };
});

app.post("/operations/:id/stop", async (request, reply) => {
  const id = z.object({ id: z.uuid() }).parse(request.params).id;
  const result = await query<{ cancel_requested: boolean; stop_requested_at: Date | null;
    name: string; status: string }>(
    `SELECT r.cancel_requested,c.stop_requested_at,c.name,c.status FROM tool_calls c
     JOIN runs r ON r.id=c.run_id WHERE c.operation_id=$1`, [id],
  );
  const call = result.rows[0];
  if (!call || !(call.cancel_requested || call.stop_requested_at) || call.name !== "shell_exec" ||
    !["dispatching", "unknown"].includes(call.status)) {
    return reply.code(409).send({ error: "No requested shell operation to stop" });
  }
  return runtimeRequest<{ stopping: boolean; pending: boolean }>("/stop", {
    method: "POST", body: JSON.stringify({ operationId: id }),
  });
});

app.post("/operations", async (request, reply) => {
  const input = z.object({
    operationId: z.uuid(), runId: z.uuid(), epoch: z.number().int().positive(),
    name: z.enum(computerToolNames as [keyof typeof toolInputSchemas, ...Array<keyof typeof toolInputSchemas>]), args: z.unknown(),
    controlEpoch: z.number().int().positive(),
    argsHash: z.string().regex(/^[a-f0-9]{64}$/), deadline: z.number().int(),
  }).parse(request.body);
  const args = toolInputSchemas[input.name].parse(input.args);
  if (createHash("sha256").update(canonicalJson(input.args)).digest("hex") !== input.argsHash) {
    return reply.code(409).send({ error: "Operation arguments do not match digest" });
  }
  const existing = operation.get(input.operationId) as OperationRow | undefined;
  if (existing) {
    if (existing.args_hash !== input.argsHash || existing.run_id !== input.runId || existing.name !== input.name) {
      return reply.code(409).send({ error: "Operation identity collision" });
    }
    return { outcome: ["succeeded", "failed"].includes(existing.status) ? existing.status : "unknown",
      result: existing.result_json ? JSON.parse(existing.result_json) : { error: "Execution receipt is incomplete" } };
  }
  if (input.deadline <= Date.now() || input.deadline > Date.now() + 125_000) {
    return reply.code(409).send({ error: "Expired or oversized deadline" });
  }
  journal.prepare(`INSERT INTO operations(operation_id,run_id,epoch,args_hash,name,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'received',?,?)`).run(input.operationId, input.runId, input.epoch,
    input.argsHash, input.name, new Date().toISOString(), new Date().toISOString());
  const release = await acquireOperationSlot();
  busy = true;
  try {
    const rejectBeforeDispatch = (status: number, error: string) => {
      journal.prepare("UPDATE operations SET status='failed',result_json=?,updated_at=? WHERE operation_id=?")
        .run(JSON.stringify({ error }), new Date().toISOString(), input.operationId);
      return reply.code(status).send({ error });
    };
    if (input.deadline <= Date.now()) return rejectBeforeDispatch(409, "Expired operation deadline");
    if ((control.get() as ControlRow).mode !== "agent" ||
      (control.get() as ControlRow).control_epoch !== input.controlEpoch) {
      return rejectBeforeDispatch(409, "Computer control is unavailable");
    }
    const state = await desktopState();
    if (state.status !== "ready" || state.controlMode !== "agent" ||
      state.controlEpoch !== input.controlEpoch) {
      return rejectBeforeDispatch(503, "Desktop is not ready");
    }
    const lease = await query(
      `SELECT 1 FROM runs r JOIN tool_calls c ON c.run_id=r.id
       JOIN bots b ON b.id=r.bot_id
       WHERE r.id=$1 AND r.status='running' AND r.cancel_requested=false
       AND r.lease_epoch=$2 AND r.lease_until>now() AND c.operation_id=$3
       AND c.status='dispatching' AND c.args_hash=$4 AND c.name=$5
       AND r.capabilities_json ? $9::text AND b.capabilities_json ? $9::text
       AND (NOT (c.name=ANY($8::text[])) OR EXISTS (
         SELECT 1 FROM approvals a WHERE a.call_id=c.id AND a.status='approved'
         AND a.args_hash=c.args_hash AND a.context_version=r.input_revision
         AND a.computer_generation=$6 AND a.control_epoch=$7 AND a.expires_at>now()
       ))`,
      [input.runId, input.epoch, input.operationId, input.argsHash, input.name,
        state.generation, state.controlEpoch, [...approvalRequiredTools],
        toolRegistry[input.name].capability],
    );
    if (!lease.rowCount) return rejectBeforeDispatch(409, "Run execution lease is invalid");
    if ((control.get() as ControlRow).mode !== "agent" ||
      (control.get() as ControlRow).control_epoch !== input.controlEpoch) {
      return rejectBeforeDispatch(409, "Computer control is unavailable");
    }
    journal.prepare("UPDATE operations SET status='dispatching',updated_at=? WHERE operation_id=?")
      .run(new Date().toISOString(), input.operationId);
    try {
      const canceled = await query<{ cancel_requested: boolean; stop_requested_at: Date | null }>(
        `SELECT r.cancel_requested,c.stop_requested_at FROM runs r JOIN tool_calls c
         ON c.run_id=r.id WHERE r.id=$1 AND c.operation_id=$2`, [input.runId, input.operationId],
      );
      if (canceled.rows[0]?.cancel_requested || canceled.rows[0]?.stop_requested_at) {
        const result = { error: canceled.rows[0].cancel_requested
          ? "任务已取消，电脑操作未派发" : "用户已请求停止，终端命令未派发" };
        journal.prepare("UPDATE operations SET status='failed',result_json=?,updated_at=? WHERE operation_id=?")
          .run(JSON.stringify(result), new Date().toISOString(), input.operationId);
        return { outcome: "failed", result };
      }
      const result = await runtimeRequest<Record<string, unknown>>("/operation", {
        method: "POST", body: JSON.stringify({ ...input, args }),
      }, Math.max(1000, input.deadline - Date.now()));
      const output = ["browser_screenshot", "desktop_observe"].includes(input.name)
        ? await persistScreenshot(input.runId, input.operationId, result) : result;
      const receipt = { ...output, generation: state.generation, controlEpoch: state.controlEpoch };
      journal.prepare("UPDATE operations SET status='succeeded',result_json=?,updated_at=? WHERE operation_id=?")
        .run(JSON.stringify(receipt), new Date().toISOString(), input.operationId);
      if (!faultDropped && process.env.OPENGROK_TEST_DROP_AFTER_RECEIPT === input.name) {
        faultDropped = true;
        reply.hijack();
        reply.raw.destroy();
        return reply;
      }
      return { outcome: "succeeded", result: receipt };
    } catch (error) {
      const result = { error: error instanceof Error ? error.message : String(error) };
      const status = error instanceof RuntimeHttpError && error.statusCode >= 400 && error.statusCode < 500
        ? "failed" : "unknown";
      journal.prepare("UPDATE operations SET status=?,result_json=?,updated_at=? WHERE operation_id=?")
        .run(status, JSON.stringify(result), new Date().toISOString(), input.operationId);
      return { outcome: status, result };
    }
  } catch (error) {
    const current = operation.get(input.operationId) as OperationRow | undefined;
    if (current?.status === "received") journal.prepare(
      "UPDATE operations SET status='failed',result_json=?,updated_at=? WHERE operation_id=?",
    ).run(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      new Date().toISOString(), input.operationId);
    throw error;
  } finally {
    busy = false;
    release();
  }
});

app.get("/receipts/:id", async (request, reply) => {
  const id = z.object({ id: z.uuid() }).parse(request.params).id;
  const row = operation.get(id) as OperationRow | undefined;
  if (!row) return reply.code(404).send({ error: "No receipt" });
  return { operationId: id, argsHash: row.args_hash,
    outcome: ["succeeded", "failed"].includes(row.status) ? row.status : "unknown",
    result: row.result_json ? JSON.parse(row.result_json) : { error: "Execution receipt is incomplete" } };
});

app.post("/control", async (_request, reply) => {
  const current = control.get() as ControlRow;
  if (current.mode === "restarting") return reply.code(409).send({ error: "Computer restart is in progress" });
  if (current.mode === "human") return { controlId: current.control_id, computer: await desktopState() };
  if (current.mode === "handing_off" && current.target_mode !== "human") {
    return reply.code(409).send({ error: "Computer control return is in progress" });
  }
  if (current.mode === "agent") {
    if ((await desktopState()).status !== "ready") return reply.code(503).send({ error: "Desktop is not ready" });
    if ((control.get() as ControlRow).mode !== "agent") {
      return reply.code(409).send({ error: "Computer control changed; retry" });
    }
    journal.prepare(`UPDATE control SET mode='handing_off',target_mode='human',control_id=NULL,
      expires_at=NULL,control_epoch=control_epoch+1 WHERE id=1`).run();
  }
  await advanceHandoff();
  const latest = control.get() as ControlRow;
  return { ...(latest.mode === "human" ? { controlId: latest.control_id } : { pending: true }),
    computer: await desktopState() };
});

app.delete("/control/:id", async request => {
  const id = z.object({ id: z.uuid() }).parse(request.params).id;
  const current = control.get() as ControlRow;
  if (current.control_id !== id || current.mode !== "human" &&
    !(current.mode === "handing_off" && current.target_mode === "agent")) {
    throw new Error("Invalid control lease");
  }
  if (current.mode === "human") journal.prepare(
    "UPDATE control SET mode='handing_off',target_mode='agent',control_epoch=control_epoch+1 WHERE id=1",
  ).run();
  await advanceHandoff();
  const latest = control.get() as ControlRow;
  return { ...(latest.mode === "handing_off" ? { pending: true } : {}), computer: await desktopState() };
});

setInterval(async () => {
  const current = control.get() as ControlRow;
  if (current.mode === "restarting") return;
  const expired = current.mode === "human" && current.expires_at && current.expires_at <= Date.now();
  if (!expired && current.mode !== "handing_off") return;
  if (expired) journal.prepare(
    "UPDATE control SET mode='handing_off',target_mode='agent',control_epoch=control_epoch+1 WHERE id=1",
  ).run();
  await advanceHandoff();
}, 5000);

await app.listen({ host: "127.0.0.1", port: Number(process.env.OPENGROK_HOST_PORT || 3842) });
