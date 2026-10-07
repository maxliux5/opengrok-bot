import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { defaultRunBudget } from "../packages/core/src/config.ts";
import { expireApprovals } from "../packages/core/src/approvals.ts";
import { pool, query, transaction } from "../packages/core/src/db.ts";
import { createRoutine, listRoutineOccurrences, testRoutine } from "../packages/core/src/routines.ts";
import { createConversation } from "../packages/core/src/resources.ts";
import { cancelRun, submitMessage } from "../packages/core/src/runs.ts";

async function seedApproval(ownerId: string, botId: string, runId: string) {
  const callId = randomUUID();
  const approvalId = randomUUID();
  await transaction(async client => {
    const run = await client.query<{ input_revision: number; model_profile_id: string }>(
      "SELECT input_revision,model_profile_id FROM runs WHERE id=$1 FOR UPDATE", [runId],
    );
    assert.ok(run.rows[0]);
    await client.query("UPDATE runs SET status='waiting_approval' WHERE id=$1", [runId]);
    await client.query(
      "UPDATE bot_execution_slots SET active_run_id=$2 WHERE bot_id=$1", [botId, runId],
    );
    const stepId = randomUUID();
    await client.query(
      `INSERT INTO model_steps(id,run_id,ordinal,input_revision,model_profile_id,status,input_snapshot)
       VALUES ($1,$2,1,$3,$4,'completed','{}'::jsonb)`,
      [stepId, runId, run.rows[0].input_revision, run.rows[0].model_profile_id],
    );
    await client.query(
      `INSERT INTO tool_calls(id,run_id,step_id,operation_id,name,args,args_hash,status,replay_policy)
       VALUES ($1,$2,$3,$4,'shell_exec','{}'::jsonb,'test','waiting_approval','manual_only')`,
      [callId, runId, stepId, randomUUID()],
    );
    await client.query(
      `INSERT INTO approvals(id,owner_id,run_id,call_id,target,args_hash,context_version,
       expires_at,status) VALUES ($1,$2,$3,$4,'测试审批','test',$5,now()-interval '1 minute','pending')`,
      [approvalId, ownerId, runId, callId, run.rows[0].input_revision],
    );
  });
  return approvalId;
}

try {
  const db = await query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(db.rows[0].name, "opengrok_routines_20261006", "refusing non-isolated DB");
  const owner = await query<{ id: string }>("SELECT id FROM users LIMIT 1");
  const bot = await query<{ id: string }>(
    "SELECT id FROM bots WHERE owner_id=$1 AND model_profile_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    [owner.rows[0].id],
  );
  const routine = await createRoutine(owner.rows[0].id, {
    botId: bot.rows[0].id, name: "审批过期测试", timeZone: "UTC", localTime: "09:00",
    inputText: "等待人工审批", deliverable: "answer", budget: defaultRunBudget, skillId: null,
  });
  const occurrence = await testRoutine(owner.rows[0].id, routine.id, randomUUID());
  assert.ok(occurrence.runId);
  const routineApproval = await seedApproval(owner.rows[0].id, bot.rows[0].id, occurrence.runId);
  assert.equal((await listRoutineOccurrences(owner.rows[0].id, routine.id))[0].runStatus,
    "waiting_approval");
  await expireApprovals();
  const run = await query<{ status: string; error: string }>(
    "SELECT status,error FROM runs WHERE id=$1", [occurrence.runId],
  );
  assert.equal(run.rows[0].status, "failed");
  assert.match(run.rows[0].error, /未自动批准/);
  const routineSlot = await query<{ active_run_id: string | null }>(
    "SELECT active_run_id FROM bot_execution_slots WHERE bot_id=$1", [bot.rows[0].id],
  );
  assert.equal(routineSlot.rows[0].active_run_id, null);

  const conversation = await createConversation(owner.rows[0].id, bot.rows[0].id);
  const normal = await submitMessage(owner.rows[0].id, conversation.id, {
    text: "普通审批过期对照", requestId: randomUUID(), deliverable: "answer",
  });
  await seedApproval(owner.rows[0].id, bot.rows[0].id, normal.run.id);
  await expireApprovals();
  const normalRun = await query<{ status: string }>("SELECT status FROM runs WHERE id=$1", [normal.run.id]);
  assert.equal(normalRun.rows[0].status, "queued");
  await cancelRun(owner.rows[0].id, normal.run.id);
  const approval = await query<{ status: string }>("SELECT status FROM approvals WHERE id=$1", [routineApproval]);
  assert.equal(approval.rows[0].status, "expired");
  console.log(JSON.stringify({ routineRunId: occurrence.runId, routineStatus: run.rows[0].status,
    normalStatusAfterExpiry: "queued", approvalStatus: approval.rows[0].status }));
} finally { await pool.end(); }
