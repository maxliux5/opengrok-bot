import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../packages/contracts/src/index.ts";
import { computerAccess, createBot, createConversation, createModelProfile, migrate,
  pool, query, requestApproval, submitMessage, type ToolCallRecord } from
  "../packages/core/src/index.ts";

const workerId = "desktop-approval-invalid-smoke";
let runId: string | null = null;

try {
  await migrate();
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE username='smoke'");
  const ownerId = owner.rows[0]?.id;
  assert.ok(ownerId);
  const profile = await createModelProfile(ownerId, {
    name: `Desktop approval ${Date.now()}`, provider: "openai-compatible",
    modelId: "test-model", baseUrl: "http://127.0.0.1:3850/v1",
  });
  const bot = await createBot(ownerId, { name: `Desktop approval ${Date.now()}`,
    description: "", instructions: "", modelProfileId: profile.id, capabilities: ["desktop"] });
  const conversation = await createConversation(ownerId, bot.id);
  const submitted = await submitMessage(ownerId, conversation.id, {
    text: "桌面审批负例", requestId: randomUUID(), deliverable: "answer",
  });
  runId = submitted.run.id;
  await query(`UPDATE runs SET status='running',lease_owner=$2,lease_epoch=1,
    lease_until=now()+interval '2 minutes' WHERE id=$1`, [runId, workerId]);
  const stepId = randomUUID();
  await query(`INSERT INTO model_steps(id,run_id,ordinal,input_revision,model_profile_id,status,
    input_snapshot,output_snapshot) VALUES ($1,$2,1,1,$3,'completed','[]'::jsonb,'{}'::jsonb)`,
  [stepId, runId, profile.id]);
  const access = await computerAccess();
  assert.equal(access.ready, true);
  let ordinal = 0;

  async function insert(name: "desktop_observe" | "desktop_click", args: object, result: unknown,
    status: "succeeded" | "proposed"): Promise<ToolCallRecord> {
    const id = randomUUID();
    const operationId = randomUUID();
    const currentOrdinal = ordinal++;
    const argsHash = createHash("sha256").update(canonicalJson(args)).digest("hex");
    await query(`INSERT INTO tool_calls(id,run_id,step_id,operation_id,ordinal,name,args,args_hash,
      status,replay_policy,result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual_only',$10)`,
    [id, runId, stepId, operationId, currentOrdinal, name,
      JSON.stringify(args), argsHash, status, result ? JSON.stringify(result) : null]);
    return { id, operationId, stepId, ordinal: currentOrdinal, name, args, argsHash, status,
      replayPolicy: "manual_only", result };
  }

  const observationId = randomUUID();
  const screenshot = (id: string) => ({ observationId: id, artifactId: randomUUID(),
    sha256: "0".repeat(64), sizeBytes: 100, sources: [], width: 100, height: 100,
    sessionId: randomUUID(), generation: access.generation, controlEpoch: access.controlEpoch });
  await insert("desktop_observe", {}, screenshot(observationId), "succeeded");
  const outside = await insert("desktop_click", {
    observationId, x: 100, y: 20, button: "left",
  }, null, "proposed");
  assert.equal(await requestApproval(outside, { runId, workerId, epoch: 1,
    computerGeneration: access.generation, controlEpoch: access.controlEpoch }), null);

  const latestObservationId = randomUUID();
  await insert("desktop_observe", {}, screenshot(latestObservationId), "succeeded");
  const stale = await insert("desktop_click", {
    observationId, x: 50, y: 50, button: "left",
  }, null, "proposed");
  assert.equal(await requestApproval(stale, { runId, workerId, epoch: 1,
    computerGeneration: access.generation, controlEpoch: access.controlEpoch }), null);
  const failed = await query<{ status: string }>(
    "SELECT status FROM tool_calls WHERE id=ANY($1::uuid[]) ORDER BY id", [[outside.id, stale.id]]);
  assert.deepEqual(failed.rows.map(row => row.status), ["failed", "failed"]);
  const approvals = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM approvals WHERE run_id=$1", [runId]);
  assert.equal(approvals.rows[0].count, "0");
  console.log(JSON.stringify({ runId, outside: "rejected", stale: "rejected", approvals: 0 }));
} finally {
  if (runId) await query(`UPDATE runs SET status='failed',error='桌面审批负例测试结束',
    lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [runId]);
  if (runId) await query(
    "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1",
    [runId],
  );
  await pool.end();
}
