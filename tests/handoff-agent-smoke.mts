import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { artifactDir } from "../packages/core/src/config.ts";
import { createSession } from "../packages/core/src/accounts.ts";
import { pool, query } from "../packages/core/src/db.ts";
import { createHandoff, handoffReceipt } from "../packages/core/src/handoffs.ts";

const base = "http://127.0.0.1:3841/api";
let cookie = "";
const processes: ChildProcess[] = [];
const logs: string[] = [];

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json() as Record<string, any>;
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function start(script: string) {
  const child = spawn(process.execPath, script.endsWith(".mjs") ? [script] : ["--import", "tsx", script], {
    cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  child.stdout?.on("data", data => logs.push(String(data)));
  child.stderr?.on("data", data => logs.push(String(data)));
  return child;
}

async function waitFor(predicate: () => Promise<boolean>, name: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for ${name}\n${logs.slice(-20).join("")}`);
}

try {
  const database = await query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(database.rows[0].name, "opengrok_handoff_20261006", "refusing non-isolated DB");
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE username='handoff_smoke'");
  assert.ok(owner.rows[0]);
  cookie = `opengrok_session=${await createSession(owner.rows[0].id)}`;
  const bots = (await api("/bots")).bots as Array<{ id: string; name: string }>;
  const a = bots.find(item => item.name === "Research A");
  const b = bots.find(item => item.name === "Review B");
  assert.ok(a && b);
  const conversation = (await api(`/bots/${a.id}/conversations`, "POST", {})).conversation;
  const artifactId = randomUUID();
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: `AGENT_DELEGATE target=${b.id} artifact=${artifactId}`,
    requestId: randomUUID(), deliverable: "answer",
  });
  const parentRunId = submitted.run.id as string;
  const markdown = Buffer.from("# 交接测试材料\n\n结果：42。\n", "utf8");
  await mkdir(join(artifactDir, parentRunId), { recursive: true, mode: 0o700 });
  await writeFile(join(artifactDir, parentRunId, `${artifactId}.md`), markdown,
    { flag: "wx", mode: 0o600 });
  await query(
    `INSERT INTO artifacts(id,owner_id,run_id,title,mime_type,sha256,size_bytes,storage_path,source_refs)
     VALUES ($1,$2,$3,'代理交接材料.md','text/markdown; charset=utf-8',$4,$5,$6,'[]')`,
    [artifactId, owner.rows[0].id, parentRunId,
      createHash("sha256").update(markdown).digest("hex"), markdown.length,
      `${parentRunId}/${artifactId}.md`],
  );
  start("tests/fake-handoff-model.mjs");
  await waitFor(async () => {
    try { await fetch("http://127.0.0.1:3850/", { signal: AbortSignal.timeout(500) }); return true; }
    catch { return false; }
  }, "fixture model", 10_000);
  start("apps/worker/src/index.ts");
  await waitFor(async () => (await api(`/runs/${parentRunId}`)).run.status === "succeeded",
    "parent Run");
  const links = await api(`/runs/${parentRunId}/handoffs`);
  assert.equal(links.children.length, 1);
  const childRunId = links.children[0].id as string;
  await waitFor(async () => (await api(`/runs/${childRunId}`)).run.status === "succeeded",
    "child Run");
  const parentCall = await query<{ id: string; operation_id: string; args_hash: string;
    args: Record<string, any>; status: string }>(
    "SELECT id,operation_id,args_hash,args,status FROM tool_calls WHERE run_id=$1 AND name='delegate_to_bot'",
    [parentRunId],
  );
  assert.equal(parentCall.rows.length, 1);
  assert.equal(parentCall.rows[0].status, "succeeded");
  const childCall = await query<{ status: string; result: Record<string, any> }>(
    "SELECT status,result FROM tool_calls WHERE run_id=$1 AND name='read_handoff_artifact'",
    [childRunId],
  );
  assert.equal(childCall.rows.length, 1);
  assert.equal(childCall.rows[0].status, "succeeded");
  assert.match(childCall.rows[0].result.content, /42/);
  const receipt = await handoffReceipt(parentCall.rows[0].operation_id, parentCall.rows[0].args_hash);
  assert.equal(receipt?.childRunId, childRunId);
  const replay = await createHandoff(owner.rows[0].id, parentRunId,
    parentCall.rows[0].operation_id, "agent", parentCall.rows[0].args as any,
    { workerId: "stale-worker", epoch: 0, callId: parentCall.rows[0].id,
      argsHash: parentCall.rows[0].args_hash });
  assert.equal(replay.run.id, childRunId);
  assert.equal((await api(`/runs/${parentRunId}/handoffs`)).children.length, 1);
  const messages = await api(`/conversations/${links.children[0].conversationId}/messages`);
  assert.match(messages.messages.at(-1).content, /42/);
  assert.ok(messages.messages.every((item: { content: string }) =>
    !item.content.includes("只供 A 使用的测试偏好")));
  console.log(JSON.stringify({ parentRunId, childRunId, delegatedTool: parentCall.rows[0].status,
    readTool: childCall.rows[0].status, replayCreatedNoDuplicate: true }));
} finally {
  for (const child of processes.reverse()) child.kill("SIGTERM");
  await Promise.all(processes.map(child => child.exitCode === null ? new Promise<void>(resolve => {
    child.once("exit", () => resolve());
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000).unref();
  }) : Promise.resolve()));
  await pool.end();
}
