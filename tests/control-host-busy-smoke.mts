import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../packages/contracts/src/index.ts";
import { computerAccess, createBot, createConversation, createModelProfile, hostRequest,
  markCallDispatching, migrate, pool, query, submitMessage } from "../packages/core/src/index.ts";

const workerId = "control-host-busy-smoke";
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const state = async () => (await hostRequest<{ computer: {
  status: string; controlMode: string; controlId: string | null; operationBusy: boolean;
} }>("/state", {}, 4000)).computer;
let runId: string | null = null;
let callId: string | null = null;
let receipt: { outcome: string; result?: { exitCode?: number } } | null = null;

try {
  await migrate();
  const initial = await state();
  assert.equal(initial.status, "ready");
  assert.equal(initial.controlMode, "agent");
  assert.equal(initial.operationBusy, false);
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE username='smoke'");
  assert.ok(owner.rows[0], "先创建隔离库的 smoke 用户");
  const ownerId = owner.rows[0].id;
  const profile = await createModelProfile(ownerId, {
    name: `Control host busy ${Date.now()}`, provider: "openai-compatible",
    modelId: "test-model", baseUrl: "http://127.0.0.1:3850/v1",
  });
  const bot = await createBot(ownerId, {
    name: `Control host busy ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id, capabilities: ["shell"],
  });
  const conversation = await createConversation(ownerId, bot.id);
  const { run } = await submitMessage(ownerId, conversation.id, {
    text: "测试在途命令接管", requestId: randomUUID(), deliverable: "answer",
  });
  runId = run.id;
  await query(`UPDATE runs SET status='running',lease_owner=$2,lease_epoch=1,
    lease_until=now()+interval '2 minutes' WHERE id=$1`, [runId, workerId]);
  const stepId = randomUUID();
  await query(`INSERT INTO model_steps(id,run_id,ordinal,input_revision,model_profile_id,status,input_snapshot,output_snapshot)
    VALUES ($1,$2,1,1,$3,'completed','[]'::jsonb,'{}'::jsonb)`, [stepId, runId, profile.id]);
  const args = { command: "sleep 6", timeoutMs: 10_000 };
  const argsHash = createHash("sha256").update(canonicalJson(args)).digest("hex");
  const operationId = randomUUID();
  callId = randomUUID();
  await query(`INSERT INTO tool_calls(id,run_id,step_id,operation_id,ordinal,name,args,args_hash,status,replay_policy)
    VALUES ($1,$2,$3,$4,0,'shell_exec',$5,$6,'authorized','manual_only')`,
  [callId, runId, stepId, operationId, JSON.stringify(args), argsHash]);
  const access = await computerAccess();
  assert.equal(access.ready, true);
  await query(`INSERT INTO approvals(id,owner_id,run_id,call_id,target,args_hash,context_version,expires_at,
    status,decided_at,computer_generation,control_epoch)
    VALUES ($1,$2,$3,$4,'/workspace: sleep 6',$5,1,now()+interval '1 minute',
    'approved',now(),$6,$7)`,
  [randomUUID(), ownerId, runId, callId, argsHash, access.generation, access.controlEpoch]);
  await markCallDispatching(callId, runId, workerId, 1);

  const operation = hostRequest<{ outcome: string; result: { exitCode?: number } }>("/operations", {
    method: "POST", body: JSON.stringify({ operationId, runId, epoch: 1,
      controlEpoch: access.controlEpoch, name: "shell_exec", args, argsHash,
      deadline: Date.now() + 20_000 }),
  }, 25_000).then(value => ({ value }), error => ({ error }));
  let executing = false;
  const journal = new DatabaseSync(".local/host-journal.sqlite", { readOnly: true });
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const row = journal.prepare("SELECT status FROM operations WHERE operation_id=?")
        .get(operationId) as { status: string } | undefined;
      if (row?.status === "dispatching" && (await state()).operationBusy) {
        executing = true;
        break;
      }
      await wait(100);
    }
  } finally { journal.close(); }
  assert.equal(executing, true, "host 未进入在途派发状态");

  const takeover = await hostRequest<{ pending?: boolean; computer: { controlMode: string } }>(
    "/control", { method: "POST" }, 8000);
  assert.equal(takeover.pending, true);
  assert.equal(takeover.computer.controlMode, "handing_off");
  const operationResult = await operation;
  if ("error" in operationResult) throw operationResult.error;
  receipt = operationResult.value;
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.result.exitCode, 0);

  let granted = await state();
  for (let attempt = 0; attempt < 15 && granted.controlMode !== "human"; attempt++) {
    await wait(1000);
    granted = await state();
  }
  assert.equal(granted.controlMode, "human");
  assert.ok(granted.controlId);
  await hostRequest(`/control/${granted.controlId}`, { method: "DELETE" }, 8000);
  let returned = await state();
  for (let attempt = 0; attempt < 10 && returned.controlMode !== "agent"; attempt++) {
    await wait(1000);
    returned = await state();
  }
  assert.equal(returned.controlMode, "agent");
  assert.equal(returned.status, "ready");
  console.log(JSON.stringify({ runId, operationId, pending: takeover.pending,
    receipt: receipt.outcome, granted: granted.controlMode, returned: returned.controlMode }));
} finally {
  const current = await state().catch(() => null);
  if (current?.controlMode === "human" && current.controlId) {
    await hostRequest(`/control/${current.controlId}`, { method: "DELETE" }, 8000).catch(() => undefined);
  }
  if (callId && runId) await query(
    `UPDATE tool_calls SET status=$2,result=$3,updated_at=now() WHERE id=$1 AND status='dispatching'`,
    [callId, receipt?.outcome === "succeeded" ? "succeeded" : "unknown",
      JSON.stringify(receipt?.result ?? { error: "接管测试中断，需核对电脑回执" })],
  );
  if (runId) await query(
    `UPDATE runs SET status=$2,error=$3,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
    [runId, receipt?.outcome === "succeeded" ? "failed" : "reconciling",
      receipt?.outcome === "succeeded" ? "接管测试结束" : "接管测试效果未核对"],
  );
  await pool.end();
}
