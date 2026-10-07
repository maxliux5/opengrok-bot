import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../packages/contracts/src/index.ts";
import { createBot, createConversation, createModelProfile, getBot, markCallDispatching,
  migrate, query, rejectDeniedCall, submitMessage, updateBot, pool, computerAccess, hostRequest,
  type DomainError } from "../packages/core/src/index.ts";

const workerId = "capability-smoke";

async function addCall(runId: string, stepId: string, ordinal: number, name: string) {
  const callId = randomUUID();
  const operationId = randomUUID();
  const args = name === "browser_open" ? { url: "https://example.com/" } : { path: "note.txt" };
  const argsHash = createHash("sha256").update(canonicalJson(args)).digest("hex");
  await query(
    `INSERT INTO tool_calls(id,run_id,step_id,operation_id,ordinal,name,args,args_hash,status,replay_policy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'authorized','idempotent')`,
    [callId, runId, stepId, operationId, ordinal, name, JSON.stringify(args), argsHash],
  );
  return { callId, operationId, args, argsHash };
}

async function expectDenied(callId: string, runId: string) {
  await assert.rejects(markCallDispatching(callId, runId, workerId, 1), error =>
    (error as DomainError).code === "capability_denied");
  await rejectDeniedCall(callId, runId, workerId, 1);
  const result = await query<{ status: string; result: { error: string } }>(
    "SELECT status,result FROM tool_calls WHERE id=$1", [callId],
  );
  assert.equal(result.rows[0].status, "failed");
  assert.match(result.rows[0].result.error, /未执行/);
}

try {
  await migrate();
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE username='smoke'");
  assert.ok(owner.rows[0], "先创建隔离库的 smoke 用户");
  const ownerId = owner.rows[0].id;
  const profile = await createModelProfile(ownerId, {
    name: `Capability smoke ${Date.now()}`, provider: "openai-compatible",
    modelId: "test-model", baseUrl: "http://127.0.0.1:3850/v1",
  });
  let bot = await createBot(ownerId, {
    name: `Capability smoke ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id, capabilities: ["public_web"],
  });
  const conversation = await createConversation(ownerId, bot.id);
  const { run } = await submitMessage(ownerId, conversation.id, {
    text: "检查工具权限", requestId: randomUUID(), deliverable: "answer",
  });
  const snapshot = await query<{ capabilities_json: string[] }>(
    "SELECT capabilities_json FROM runs WHERE id=$1", [run.id],
  );
  assert.deepEqual(snapshot.rows[0].capabilities_json, ["public_web"]);
  await query(
    `UPDATE runs SET status='running',lease_owner=$2,lease_epoch=1,
     lease_until=now()+interval '1 minute' WHERE id=$1`, [run.id, workerId],
  );
  const stepId = randomUUID();
  await query(
    `INSERT INTO model_steps(id,run_id,ordinal,input_revision,model_profile_id,status,input_snapshot,output_snapshot)
     VALUES ($1,$2,1,1,$3,'completed','[]'::jsonb,'{}'::jsonb)`,
    [stepId, run.id, profile.id],
  );

  bot = await updateBot(ownerId, bot.id, {
    capabilities: ["public_web", "workspace"], expectedRevision: bot.revision,
  });
  const workspaceCall = await addCall(run.id, stepId, 0, "workspace_read");
  await expectDenied(workspaceCall.callId, run.id);

  bot = await updateBot(ownerId, bot.id, {
    capabilities: ["workspace"], expectedRevision: bot.revision,
  });
  const revokedWebCall = await addCall(run.id, stepId, 1, "browser_open");
  await expectDenied(revokedWebCall.callId, run.id);

  bot = await updateBot(ownerId, bot.id, {
    capabilities: ["public_web", "workspace"], expectedRevision: bot.revision,
  });
  assert.deepEqual((await getBot(ownerId, bot.id)).capabilities, ["public_web", "workspace"]);
  const allowedWebCall = await addCall(run.id, stepId, 2, "browser_open");
  const dispatch = await markCallDispatching(allowedWebCall.callId, run.id, workerId, 1);
  assert.equal(dispatch.status, "dispatching");
  if (process.env.OPENGROK_EXPECT_HOST_DENIAL === "1") {
    bot = await updateBot(ownerId, bot.id, {
      capabilities: ["workspace"], expectedRevision: bot.revision,
    });
    const computer = await computerAccess();
    assert.equal(computer.ready, true);
    await assert.rejects(hostRequest("/operations", {
      method: "POST", body: JSON.stringify({ operationId: allowedWebCall.operationId,
        runId: run.id, epoch: 1, controlEpoch: computer.controlEpoch,
        name: "browser_open", args: allowedWebCall.args, argsHash: allowedWebCall.argsHash,
        deadline: Date.now() + 30_000 }),
    }), error => (error as DomainError).code === "host_rejected");
    const journal = new DatabaseSync(".local/host-journal.sqlite", { readOnly: true });
    const physical = journal.prepare("SELECT COUNT(*) AS count FROM operations WHERE run_id=?")
      .get(run.id) as { count: number };
    journal.close();
    assert.equal(physical.count, 0);
  }
  const counts = await query<{ denied: number; dispatching: number }>(
    `SELECT COUNT(*) FILTER (WHERE status='failed')::int AS denied,
     COUNT(*) FILTER (WHERE status='dispatching')::int AS dispatching
     FROM tool_calls WHERE run_id=$1`, [run.id],
  );
  assert.deepEqual(counts.rows[0], { denied: 2, dispatching: 1 });
  console.log(JSON.stringify({ runId: run.id, snapshot: snapshot.rows[0].capabilities_json,
    denied: counts.rows[0].denied, dispatching: counts.rows[0].dispatching }));
  await query("UPDATE tool_calls SET status='failed',result=$2 WHERE id=$1",
    [allowedWebCall.callId, JSON.stringify({ error: "测试未执行电脑操作" })]);
  await query("UPDATE runs SET status='failed',error='能力边界测试完成',lease_owner=NULL,lease_until=NULL WHERE id=$1",
    [run.id]);
} finally {
  await pool.end();
}
