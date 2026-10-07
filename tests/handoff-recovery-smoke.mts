import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBot, createConversation, createModelProfile, handoffReceipt, migrate,
  pool, query, setupOwner, submitMessage } from "../packages/core/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const databaseName = "opengrok_handoff_recovery_20261006";
assert.equal(resolve(process.env.OPENGROK_DATA_DIR || ""),
  resolve(root, ".local/handoff-recovery-20261006"), "必须使用专属测试目录");
assert.equal((await query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name,
  databaseName, "必须使用专属交接恢复数据库");
await migrate();
assert.equal((await query<{ count: string }>("SELECT count(*)::text AS count FROM users")).rows[0].count,
  "0", "交接恢复测试只在全新数据库运行");

const owner = await setupOwner("handoff-recovery", `handoff-${randomUUID()}`);
const profile = await createModelProfile(owner.id, {
  name: "Handoff recovery fixture", provider: "openai-compatible", modelId: "handoff-recovery",
  baseUrl: "http://127.0.0.1:3892/v1",
  capabilities: { text: true, tools: true, vision: false, streaming: false },
});
const parentBot = await createBot(owner.id, {
  name: "Recovery Parent", description: "", instructions: "", modelProfileId: profile.id,
  capabilities: ["delegate"],
});
const childBot = await createBot(owner.id, {
  name: "Recovery Child", description: "", instructions: "", modelProfileId: profile.id,
  capabilities: [],
});
const conversation = await createConversation(owner.id, parentBot.id);
const parent = await submitMessage(owner.id, conversation.id, {
  text: `AGENT_DELEGATE target=${childBot.id}`, requestId: randomUUID(), deliverable: "answer",
});
const parentRunId = parent.run.id;
const logs: string[] = [];
const workers: ChildProcess[] = [];
let triggerInstalled = false;

const model = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const userText = input.messages.filter((message: { role: string }) => message.role === "user")
      .map((message: { content: unknown }) => JSON.stringify(message.content)).join("\n");
    const usedTool = input.messages.some((message: { role: string }) => message.role === "tool");
    const target = userText.match(/AGENT_DELEGATE target=([0-9a-f-]{36})/i)?.[1];
    const toolCall = target && !usedTool ? {
      id: "call_delegate", type: "function", function: {
        name: "delegate_to_bot", arguments: JSON.stringify({ targetBotId: target,
          task: "确认恢复后的子任务", acceptance: "子任务回复已处理", deliverable: "answer",
          artifactIds: [] }),
      },
    } : null;
    const message = toolCall ? { role: "assistant", content: null, tool_calls: [toolCall] }
      : { role: "assistant", content: target ? "父 Bot 已确认交接。" : "子 Bot 已处理交接。" };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: randomUUID(), object: "chat.completion", created: Math.floor(Date.now() / 1000),
      model: input.model, choices: [{ index: 0, message,
        finish_reason: toolCall ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 },
    }));
  } catch (error) {
    console.error("fixture model failed:", error);
    response.writeHead(500).end();
  }
});

function startWorker() {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/worker/src/index.ts"], {
    cwd: root, env: { ...process.env, OPENGROK_HOST_URL: "http://127.0.0.1:3894" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", chunk => logs.push(String(chunk)));
  child.stderr?.on("data", chunk => logs.push(String(chunk)));
  workers.push(child);
  return child;
}

async function waitFor(name: string, timeoutMs: number, condition: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(200);
  }
  throw new Error(`等待 ${name} 超时：\n${logs.slice(-20).join("")}`);
}

try {
  await new Promise<void>((resolveListen, reject) => {
    model.once("error", reject);
    model.listen(3892, "127.0.0.1", resolveListen);
  });
  await query(`CREATE FUNCTION handoff_recovery_delay() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.name='delegate_to_bot' AND OLD.status='dispatching' AND NEW.status='succeeded' THEN
        PERFORM pg_sleep(25);
      END IF;
      RETURN NEW;
    END $$`);
  await query(`CREATE TRIGGER handoff_recovery_before_result BEFORE UPDATE ON tool_calls
    FOR EACH ROW EXECUTE FUNCTION handoff_recovery_delay()`);
  triggerInstalled = true;
  const first = startWorker();
  await waitFor("交接提交后、工具结果落库前的窗口", 30_000, async () => {
    const child = await query("SELECT 1 FROM runs WHERE parent_run_id=$1", [parentRunId]);
    const call = await query<{ status: string }>(
      "SELECT status FROM tool_calls WHERE run_id=$1 AND name='delegate_to_bot'", [parentRunId]);
    const sleeping = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event='PgSleep'`);
    return child.rowCount === 1 && call.rows[0]?.status === "dispatching" &&
      Number(sleeping.rows[0].count) > 0;
  });
  first.kill("SIGKILL");
  await new Promise<void>(resolveExit => first.once("exit", () => resolveExit()));
  await query("DROP TRIGGER handoff_recovery_before_result ON tool_calls");
  await query("DROP FUNCTION handoff_recovery_delay()");
  triggerInstalled = false;

  const afterCrash = await query<{ child_id: string; call_status: string; run_status: string }>(
    `SELECT c.id AS child_id,t.status AS call_status,p.status AS run_status
     FROM runs c JOIN runs p ON p.id=c.parent_run_id
     JOIN tool_calls t ON t.run_id=p.id AND t.name='delegate_to_bot'
     WHERE c.parent_run_id=$1`, [parentRunId]);
  assert.equal(afterCrash.rows.length, 1);
  assert.equal(afterCrash.rows[0].call_status, "dispatching");
  assert.equal(afterCrash.rows[0].run_status, "running");
  const childRunId = afterCrash.rows[0].child_id;

  startWorker();
  await waitFor("父子任务恢复成功", 100_000, async () => {
    const runs = await query<{ id: string; status: string }>(
      "SELECT id,status FROM runs WHERE id=$1 OR id=$2", [parentRunId, childRunId]);
    return runs.rows.length === 2 && runs.rows.every(row => row.status === "succeeded");
  });
  const final = await query<{ child_count: string; call_count: string; call_status: string;
    tool_count: number; reconciled: string; sent: string; parent_result: string; child_result: string }>(
    `SELECT (SELECT count(*)::text FROM runs WHERE parent_run_id=$1) AS child_count,
      (SELECT count(*)::text FROM tool_calls WHERE run_id=$1 AND name='delegate_to_bot') AS call_count,
      (SELECT status FROM tool_calls WHERE run_id=$1 AND name='delegate_to_bot') AS call_status,
      p.tool_count,
      (SELECT count(*)::text FROM run_events WHERE run_id=$1 AND kind='tool_reconciled') AS reconciled,
      (SELECT count(*)::text FROM run_events WHERE run_id=$1 AND kind='handoff_sent') AS sent,
      p.result_text AS parent_result,c.result_text AS child_result
     FROM runs p JOIN runs c ON c.parent_run_id=p.id WHERE p.id=$1`, [parentRunId]);
  const row = final.rows[0];
  assert.equal(row.child_count, "1");
  assert.equal(row.call_count, "1");
  assert.equal(row.call_status, "succeeded");
  assert.equal(row.tool_count, 1);
  assert.equal(row.reconciled, "1");
  assert.equal(row.sent, "1");
  assert.match(row.parent_result, /父 Bot 已确认交接/);
  assert.match(row.child_result, /子 Bot 已处理交接/);
  const call = await query<{ operation_id: string; args_hash: string }>(
    "SELECT operation_id,args_hash FROM tool_calls WHERE run_id=$1 AND name='delegate_to_bot'",
    [parentRunId]);
  assert.equal((await handoffReceipt(call.rows[0].operation_id, call.rows[0].args_hash))?.childRunId,
    childRunId);
  console.log(JSON.stringify({ parentRunId, childRunId, afterCrash: afterCrash.rows[0],
    recoveredCall: row.call_status, reconciledEvents: row.reconciled,
    childCount: row.child_count, parentStatus: "succeeded", childStatus: "succeeded" }));
} finally {
  for (const worker of workers) worker.kill("SIGTERM");
  await Promise.all(workers.map(async worker => {
    if (worker.exitCode !== null || worker.signalCode !== null) return;
    await Promise.race([new Promise(resolveExit => worker.once("exit", resolveExit)), delay(3000)]);
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  }));
  if (triggerInstalled) {
    await query("DROP TRIGGER IF EXISTS handoff_recovery_before_result ON tool_calls");
    await query("DROP FUNCTION IF EXISTS handoff_recovery_delay()");
  }
  await new Promise<void>(resolveClose => model.close(() => resolveClose()));
  await pool.end();
}
