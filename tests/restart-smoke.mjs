import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

if (process.env.OPENGROK_ALLOW_DESKTOP_RESTART_TEST !== "1") {
  throw new Error("Set OPENGROK_ALLOW_DESKTOP_RESTART_TEST=1 to recreate the desktop container");
}

const runtimeToken = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];
const hostToken = readFileSync(".local/host.token", "utf8").trim();
const runtimeHeaders = { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" };
const hostHeaders = { authorization: `Bearer ${hostToken}` };
const path = `runs/restart-smoke-${randomUUID()}.txt`;
const content = `restart persistence ${randomUUID()}\n`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function operation(name, args) {
  const response = await fetch("http://127.0.0.1:3843/operation", {
    method: "POST", headers: runtimeHeaders,
    body: JSON.stringify({ name, args, operationId: randomUUID(), deadline: Date.now() + 45_000 }),
    signal: AbortSignal.timeout(50_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${name}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

async function state() {
  const response = await fetch("http://127.0.0.1:3842/state", { headers: hostHeaders });
  if (!response.ok) throw new Error(`Host state: ${response.status}`);
  return (await response.json()).computer;
}

const before = await state();
if (before.status !== "ready" || before.controlMode !== "agent" || before.operationBusy) {
  throw new Error("Computer must be idle in Agent mode before this test");
}

try {
  const written = await operation("workspace_write", { path, content });
  const restart = await fetch("http://127.0.0.1:3842/restart", {
    method: "POST", headers: hostHeaders,
  });
  const accepted = await restart.json();
  const blocked = await fetch("http://127.0.0.1:3842/control", {
    method: "POST", headers: hostHeaders,
  });
  let after = await state();
  for (let attempt = 0; attempt < 120 && (after.status !== "ready" ||
    after.controlMode !== "agent" || after.sessionId === before.sessionId); attempt++) {
    await wait(1000);
    after = await state();
  }
  const read = await operation("workspace_read", { path });
  console.log(JSON.stringify({ restartStatus: restart.status, acceptedMode: accepted.computer?.controlMode,
    controlDuringRestart: blocked.status, oldSession: before.sessionId, newSession: after.sessionId,
    oldGeneration: before.generation, newGeneration: after.generation,
    fileUnchanged: read.sha256 === written.sha256 && read.content === content,
    status: after.status, mode: after.controlMode }));
  if (restart.status !== 200 || accepted.computer?.controlMode !== "restarting" ||
    blocked.status !== 409 || after.status !== "ready" || after.controlMode !== "agent" ||
    after.sessionId === before.sessionId || after.generation <= before.generation ||
    read.sha256 !== written.sha256 || read.content !== content) process.exitCode = 1;
} finally {
  await operation("shell_exec", { command: `rm -- /workspace/${path}`, timeoutMs: 5000 }).catch(() => undefined);
}
