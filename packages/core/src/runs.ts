import { randomUUID } from "node:crypto";
import type { Message, Run, RunBudget, RunEvent, RunStatus, ToolCapability } from "@opengrok/contracts";
import type { PoolClient } from "pg";
import { query, transaction } from "./db.js";
import { DomainError } from "./errors.js";
import { hostRequest } from "./host-auth.js";
import { defaultRunBudget } from "./config.js";
import { snapshotBoundSkills } from "./skills.js";

type RunRow = {
  id: string; owner_id: string; bot_id: string; conversation_id: string;
  parent_run_id: string | null; root_run_id: string | null; delegation_depth: number;
  model_profile_id: string | null; expected_artifact: boolean;
  status: RunStatus; input_revision: number; consumed_input_sequence: number;
  event_sequence: string; lease_epoch: string; lease_owner: string | null;
  cancel_requested: boolean; result_text: string | null; error: string | null;
  unresolved_effects: Run["unresolvedEffects"];
  tool_count: number; token_count: number; token_usage_estimated: boolean;
  budget_json: RunBudget;
  capabilities_json: ToolCapability[];
  created_at: Date; updated_at: Date;
};
type MessageRow = {
  id: string; conversation_id: string; run_id: string | null;
  role: Message["role"]; content: string; created_at: Date;
};
type EventRow = {
  run_id: string; sequence: string; kind: string;
  payload: Record<string, unknown>; created_at: Date;
};

function toRun(row: RunRow): Run {
  return {
    id: row.id, botId: row.bot_id, conversationId: row.conversation_id,
    parentRunId: row.parent_run_id, rootRunId: row.root_run_id,
    delegationDepth: row.delegation_depth,
    status: row.status, inputRevision: row.input_revision,
    consumedInputSequence: row.consumed_input_sequence,
    expectedArtifact: row.expected_artifact,
    budget: row.budget_json, tokenCount: row.token_count,
    tokenUsageEstimated: row.token_usage_estimated, toolCount: row.tool_count,
    resultText: row.result_text, error: row.error,
    unresolvedEffects: row.unresolved_effects,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id, conversationId: row.conversation_id,
    runId: row.run_id, role: row.role, content: row.content,
    createdAt: row.created_at.toISOString(),
  };
}

export async function addEvent(
  client: PoolClient, runId: string, kind: string, payload: Record<string, unknown> = {},
) {
  const next = await client.query<{ event_sequence: string }>(
    "UPDATE runs SET event_sequence=event_sequence+1,updated_at=now() WHERE id=$1 RETURNING event_sequence",
    [runId],
  );
  if (!next.rows[0]) throw new DomainError("找不到任务", 404, "run_not_found");
  await client.query(
    "INSERT INTO run_events(run_id,sequence,kind,payload) VALUES ($1,$2,$3,$4)",
    [runId, next.rows[0].event_sequence, kind, JSON.stringify(payload)],
  );
}

export async function getRun(ownerId: string, runId: string): Promise<Run> {
  const result = await query<RunRow>(
    "SELECT * FROM runs WHERE owner_id=$1 AND id=$2", [ownerId, runId],
  );
  if (!result.rows[0]) throw new DomainError("找不到任务", 404, "run_not_found");
  return toRun(result.rows[0]);
}

export async function listRuns(ownerId: string, conversationId: string): Promise<Run[]> {
  const result = await query<RunRow>(
    "SELECT * FROM runs WHERE owner_id=$1 AND conversation_id=$2 ORDER BY created_at,id",
    [ownerId, conversationId],
  );
  return result.rows.map(toRun);
}

export async function listMessages(ownerId: string, conversationId: string): Promise<Message[]> {
  const owned = await query(
    "SELECT 1 FROM conversations WHERE owner_id=$1 AND id=$2", [ownerId, conversationId],
  );
  if (!owned.rowCount) throw new DomainError("找不到对话", 404, "conversation_not_found");
  const result = await query<MessageRow>(
    "SELECT * FROM messages WHERE owner_id=$1 AND conversation_id=$2 ORDER BY created_at,id",
    [ownerId, conversationId],
  );
  return result.rows.map(toMessage);
}

export async function listEvents(ownerId: string, runId: string, afterSequence = 0): Promise<RunEvent[]> {
  await getRun(ownerId, runId);
  const result = await query<EventRow>(
    "SELECT * FROM run_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 200",
    [runId, afterSequence],
  );
  return result.rows.map(row => ({
    runId: row.run_id, sequence: Number(row.sequence), kind: row.kind,
    payload: row.payload, createdAt: row.created_at.toISOString(),
  }));
}

export async function submitMessage(ownerId: string, conversationId: string, input: {
  text: string; requestId: string; deliverable: "answer" | "report";
}, options?: { budget?: RunBudget; skillVersion?: { skillId: string; version: number } | null }):
  Promise<{ run: Run; message: Message }> {
  const assigned = await transaction(async client => {
    const conversation = await client.query<{ bot_id: string; title: string; model_profile_id: string | null;
      capabilities_json: ToolCapability[] }>(
      `SELECT c.bot_id,c.title,b.model_profile_id,b.capabilities_json FROM conversations c
       JOIN bots b ON b.id=c.bot_id AND b.owner_id=c.owner_id
       WHERE c.owner_id=$1 AND c.id=$2 FOR UPDATE OF c`,
      [ownerId, conversationId],
    );
    const entry = conversation.rows[0];
    if (!entry) throw new DomainError("找不到对话", 404, "conversation_not_found");

    const repeated = await client.query<{ run_id: string; message_id: string }>(
      "SELECT run_id,message_id FROM run_inputs WHERE owner_id=$1 AND client_request_id=$2",
      [ownerId, input.requestId],
    );
    if (repeated.rows[0]) return { runId: repeated.rows[0].run_id, messageId: repeated.rows[0].message_id };

    const open = await client.query<RunRow>(
      `SELECT * FROM runs WHERE owner_id=$1 AND conversation_id=$2
       AND status IN ('queued','running','waiting_approval','waiting_user','waiting_computer','verifying')
       AND cancel_requested=false ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [ownerId, conversationId],
    );
    const canReport = (capabilities: ToolCapability[]) =>
      capabilities.includes("public_web") && capabilities.includes("artifact");
    if (input.deliverable === "report" &&
      (!canReport(entry.capabilities_json) ||
        open.rows[0] && !canReport(open.rows[0].capabilities_json))) {
      throw new DomainError("报告任务需要网页浏览和成果发布能力", 403, "report_capability_denied");
    }
    let runId = open.rows[0]?.id;
    let sequence = 1;
    if (!runId) {
      if (!entry.model_profile_id) throw new DomainError("请先为 Bot 选择模型", 422, "model_required");
      runId = randomUUID();
      await client.query(
        `INSERT INTO runs(id,owner_id,bot_id,conversation_id,model_profile_id,status,
         expected_artifact,input_revision,budget_json,capabilities_json)
         VALUES ($1,$2,$3,$4,$5,'queued',$6,1,$7,$8)`,
        [runId, ownerId, entry.bot_id, conversationId, entry.model_profile_id,
          input.deliverable === "report", JSON.stringify(options?.budget ?? defaultRunBudget),
          JSON.stringify(entry.capabilities_json)],
      );
      await snapshotBoundSkills(client, runId, entry.bot_id, options?.skillVersion);
    } else {
      const count = await client.query<{ next: number }>(
        "SELECT COALESCE(MAX(sequence),0)+1 AS next FROM run_inputs WHERE run_id=$1", [runId],
      );
      sequence = count.rows[0].next;
      await client.query(
        `UPDATE runs SET input_revision=input_revision+1,
         expected_artifact=expected_artifact OR $2,
         status=CASE WHEN status IN ('waiting_approval','waiting_user','waiting_computer','verifying')
           THEN 'queued' ELSE status END,
         updated_at=now() WHERE id=$1`,
        [runId, input.deliverable === "report"],
      );
      await client.query(
        `UPDATE approvals SET status='expired',decided_at=now()
         WHERE run_id=$1 AND status='pending'`, [runId],
      );
      await client.query(
        `UPDATE tool_calls SET status='failed',result=$2,updated_at=now()
         WHERE run_id=$1 AND status='waiting_approval'`,
        [runId, JSON.stringify({ error: "用户补充要求，旧审批失效" })],
      );
    }

    const messageId = randomUUID();
    await client.query(
      `INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content)
       VALUES ($1,$2,$3,$4,'user',$5)`,
      [messageId, ownerId, conversationId, runId, input.text],
    );
    await client.query(
      `INSERT INTO run_inputs(id,owner_id,run_id,message_id,client_request_id,sequence)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), ownerId, runId, messageId, input.requestId, sequence],
    );
    await client.query(
      `UPDATE conversations SET updated_at=now(),
       title=CASE WHEN title='新对话' THEN $2 ELSE title END WHERE id=$1`,
      [conversationId, input.text.slice(0, 64)],
    );
    await addEvent(client, runId, "input_added", { messageId, sequence });
    return { runId, messageId };
  });
  const [run, messages] = await Promise.all([
    getRun(ownerId, assigned.runId),
    query<MessageRow>("SELECT * FROM messages WHERE id=$1", [assigned.messageId]),
  ]);
  return { run, message: toMessage(messages.rows[0]) };
}

export async function cancelRun(ownerId: string, runId: string): Promise<Run> {
  await transaction(async client => {
    const locked = await client.query<RunRow>(
      "SELECT * FROM runs WHERE owner_id=$1 AND id=$2 FOR UPDATE", [ownerId, runId],
    );
    const run = locked.rows[0];
    if (!run) throw new DomainError("找不到任务", 404, "run_not_found");
    if (["succeeded", "failed", "canceled"].includes(run.status)) return;
    if (run.status === "reconciling") {
      if (!run.cancel_requested) {
        await client.query("UPDATE runs SET cancel_requested=true,updated_at=now() WHERE id=$1", [runId]);
        await addEvent(client, runId, "cancel_requested");
      }
      return;
    }
    const active = await client.query(
      "SELECT 1 FROM tool_calls WHERE run_id=$1 AND status='dispatching' LIMIT 1", [runId],
    );
    const immediate = ["queued", "waiting_user", "waiting_approval", "waiting_computer"].includes(run.status)
      && !active.rowCount;
    await client.query(
      `UPDATE runs SET cancel_requested=true,status=$2,
       lease_owner=CASE WHEN $3 THEN NULL ELSE lease_owner END,
       lease_until=CASE WHEN $3 THEN NULL ELSE lease_until END,updated_at=now()
       WHERE id=$1`, [runId, immediate ? "canceled" : "canceling", immediate],
    );
    if (immediate) await client.query(
      "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1", [runId],
    );
    await client.query(
      "UPDATE approvals SET status='expired',decided_at=now() WHERE run_id=$1 AND status='pending'", [runId],
    );
    await client.query(
      `UPDATE tool_calls SET status='failed',result=$2,updated_at=now()
       WHERE run_id=$1 AND status='waiting_approval'`,
      [runId, JSON.stringify({ error: "用户已取消任务" })],
    );
    await addEvent(client, runId, immediate ? "canceled" : "cancel_requested");
  });
  return getRun(ownerId, runId);
}

export async function listPendingEffects(ownerId: string, runId: string) {
  await getRun(ownerId, runId);
  const result = await query<{
    operation_id: string; name: string; args: Record<string, unknown>;
    status: string; result: unknown;
  }>(
    `SELECT operation_id,name,args,status,result FROM tool_calls WHERE run_id=$1
     AND status IN ('dispatching','unknown') ORDER BY created_at,id`, [runId],
  );
  return result.rows.map(row => ({ operationId: row.operation_id, name: row.name,
    args: row.args, status: row.status, result: row.result }));
}

export async function closeRunWithUnknownEffects(ownerId: string, runId: string) {
  const pending = await listPendingEffects(ownerId, runId);
  if (!pending.length) throw new DomainError("任务没有待核对的电脑操作", 409, "no_unknown_effect");
  const { computer } = await hostRequest<{ computer: { status: string; operationBusy: boolean } }>("/state", {}, 4000);
  if (computer.status !== "ready" || computer.operationBusy) {
    throw new DomainError("电脑操作尚未确认静止", 409, "computer_busy");
  }
  const acknowledgedAt = new Date().toISOString();
  const effects = await Promise.all(pending.map(async item => {
    let receipt: { outcome: string; result?: unknown };
    try {
      receipt = await hostRequest(`/receipts/${item.operationId}`, {}, 4000);
    } catch (error) {
      if (!(error instanceof DomainError && error.statusCode === 404)) throw error;
      receipt = { outcome: "missing" };
    }
    if (receipt.outcome === "succeeded" || receipt.outcome === "failed") {
      throw new DomainError("电脑回执已确定，等待自动核对", 409, "receipt_determined");
    }
    return { operationId: item.operationId, name: item.name, evidence: [
      { source: "computer-host", outcome: receipt.outcome,
        detail: JSON.stringify(receipt.result ?? {}).slice(0, 2000) },
      { source: "user", action: "stop_unverified", at: acknowledgedAt },
    ] };
  }));
  await transaction(async client => {
    const locked = await client.query<RunRow>(
      "SELECT * FROM runs WHERE id=$1 AND owner_id=$2 FOR UPDATE", [runId, ownerId],
    );
    if (locked.rows[0]?.status !== "reconciling") {
      throw new DomainError("任务状态已变化，请刷新", 409, "run_changed");
    }
    const current = await client.query<{ operation_id: string }>(
      `SELECT operation_id FROM tool_calls WHERE run_id=$1 AND status IN ('dispatching','unknown')
       ORDER BY created_at,id FOR UPDATE`, [runId],
    );
    if (current.rows.length !== effects.length ||
      current.rows.some((row, index) => row.operation_id !== effects[index].operationId)) {
      throw new DomainError("待核对操作已变化，请刷新", 409, "effects_changed");
    }
    await client.query(
      `UPDATE runs SET status='canceled',cancel_requested=true,lease_owner=NULL,lease_until=NULL,
       unresolved_effects=unresolved_effects || $2::jsonb,error=$3,updated_at=now() WHERE id=$1`,
      [runId, JSON.stringify(effects), "任务已结束，外部操作结果未核对"],
    );
    await client.query(
      "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1", [runId],
    );
    await addEvent(client, runId, "closed_with_unknown_effects", { operations: effects.map(item => item.operationId) });
  });
  return getRun(ownerId, runId);
}

export async function claimNextRun(workerId: string): Promise<{ runId: string; epoch: number } | null> {
  return transaction(async client => {
    const candidate = await client.query<RunRow>(
      `SELECT r.* FROM runs r JOIN bot_execution_slots s ON s.bot_id=r.bot_id
       WHERE r.status='queued' AND r.cancel_requested=false AND r.next_wake_at<=now()
       AND (s.active_run_id IS NULL OR s.active_run_id=r.id)
       ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
    );
    const run = candidate.rows[0];
    if (!run) return null;
    const slot = await client.query<{ active_run_id: string | null }>(
      "SELECT active_run_id FROM bot_execution_slots WHERE bot_id=$1 FOR UPDATE", [run.bot_id],
    );
    if (slot.rows[0]?.active_run_id && slot.rows[0].active_run_id !== run.id) return null;
    await client.query(
      `UPDATE bot_execution_slots SET active_run_id=$2,revision=revision+1 WHERE bot_id=$1`,
      [run.bot_id, run.id],
    );
    const updated = await client.query<{ lease_epoch: string }>(
      `UPDATE runs SET status='running',lease_owner=$2,
       lease_until=now()+interval '30 seconds',lease_epoch=lease_epoch+1,updated_at=now()
       WHERE id=$1 RETURNING lease_epoch`, [run.id, workerId],
    );
    await addEvent(client, run.id, "running", { workerId });
    return { runId: run.id, epoch: Number(updated.rows[0].lease_epoch) };
  });
}

export async function heartbeat(runId: string, workerId: string, epoch: number): Promise<boolean> {
  const result = await query(
    `UPDATE runs SET lease_until=now()+interval '30 seconds'
     WHERE id=$1 AND status IN ('running','canceling') AND lease_owner=$2 AND lease_epoch=$3
     AND lease_until>now()`,
    [runId, workerId, epoch],
  );
  return Boolean(result.rowCount);
}

export async function markInputsConsumed(runId: string, workerId: string, epoch: number, sequence: number) {
  const result = await query(
    `UPDATE runs SET consumed_input_sequence=GREATEST(consumed_input_sequence,$4)
     WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_epoch=$3
     AND cancel_requested=false`,
    [runId, workerId, epoch, sequence],
  );
  if (!result.rowCount) throw new DomainError("任务执行权已失效", 409, "lease_lost");
}

export async function releaseAfterInputChange(runId: string, workerId: string, epoch: number) {
  await transaction(async client => {
    const result = await client.query(
      `UPDATE runs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running'
       RETURNING id`, [runId, workerId, epoch],
    );
    if (result.rowCount) await addEvent(client, runId, "requeued_for_input");
  });
}

export async function finishRun(runId: string, workerId: string, epoch: number,
  inputRevision: number, text: string): Promise<"succeeded" | "requeued" | "lost"> {
  return transaction(async client => {
    const conversation = await client.query(
      `SELECT c.id FROM conversations c JOIN runs r ON r.conversation_id=c.id
       WHERE r.id=$1 FOR UPDATE OF c`, [runId],
    );
    if (!conversation.rowCount) return "lost";
    const locked = await client.query<RunRow>("SELECT * FROM runs WHERE id=$1 FOR UPDATE", [runId]);
    const run = locked.rows[0];
    if (!run || run.lease_owner !== workerId || Number(run.lease_epoch) !== epoch || run.status !== "running") {
      return "lost";
    }
    if (run.cancel_requested) return "lost";
    if (run.input_revision !== inputRevision) {
      await client.query(
        "UPDATE runs SET status='queued',lease_owner=NULL,lease_until=NULL WHERE id=$1", [runId],
      );
      await addEvent(client, runId, "requeued_for_input");
      return "requeued";
    }
    if (run.expected_artifact) {
      const existing = await client.query(
        "SELECT 1 FROM artifacts WHERE run_id=$1 AND mime_type='text/markdown; charset=utf-8' LIMIT 1",
        [runId],
      );
      if (!existing.rowCount) {
        await client.query(
          "UPDATE runs SET status='failed',error=$2,lease_owner=NULL,lease_until=NULL WHERE id=$1",
          [runId, "报告未发布为可打开的成果"],
        );
        await client.query(
          "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1", [runId],
        );
        await addEvent(client, runId, "failed", { reason: "missing_artifact" });
        return "lost";
      }
    }
    const messageId = randomUUID();
    await client.query(
      `INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content)
       VALUES ($1,$2,$3,$4,'assistant',$5)`,
      [messageId, run.owner_id, run.conversation_id, runId, text],
    );
    await client.query(
      `UPDATE runs SET status='succeeded',result_text=$2,lease_owner=NULL,lease_until=NULL,
       updated_at=now() WHERE id=$1`, [runId, text],
    );
    await client.query(
      "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1", [runId],
    );
    await addEvent(client, runId, "succeeded", { messageId });
    return "succeeded";
  });
}

export async function failRun(runId: string, workerId: string, epoch: number, error: string) {
  await transaction(async client => {
    const updated = await client.query(
      `UPDATE runs SET status='failed',error=$4,lease_owner=NULL,lease_until=NULL,updated_at=now()
       WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 AND status='running' RETURNING id`,
      [runId, workerId, epoch, error.slice(0, 2000)],
    );
    if (!updated.rowCount) return;
    const unsent = await client.query(
      `UPDATE tool_calls SET status='failed',result=$2,updated_at=now()
       WHERE run_id=$1 AND status IN ('proposed','authorized','waiting_approval') RETURNING id`,
      [runId, JSON.stringify({ error: "任务已失败，工具未执行" })],
    );
    await client.query(
      "UPDATE approvals SET status='expired',decided_at=now() WHERE run_id=$1 AND status='pending'",
      [runId],
    );
    await client.query(
      "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1", [runId],
    );
    if (unsent.rowCount) await addEvent(client, runId, "pending_tools_invalidated", {
      count: unsent.rowCount, reason: "run_failed",
    });
    await addEvent(client, runId, "failed", { reason: error.slice(0, 2000) });
  });
}

export async function acknowledgeCancel(runId: string, workerId: string, epoch: number) {
  await transaction(async client => {
    const run = await client.query<RunRow>(
      "SELECT * FROM runs WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3 FOR UPDATE",
      [runId, workerId, epoch],
    );
    if (!run.rows[0] || !run.rows[0].cancel_requested || run.rows[0].status !== "canceling") return;
    const pending = await client.query(
      "SELECT 1 FROM tool_calls WHERE run_id=$1 AND status IN ('dispatching','unknown') LIMIT 1", [runId],
    );
    const status = pending.rowCount ? "reconciling" : "canceled";
    await client.query(
      "UPDATE runs SET status=$2,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
      [runId, status],
    );
    if (status === "canceled") await client.query(
      "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1", [runId],
    );
    await addEvent(client, runId, status);
  });
}

export async function waitForComputer(runId: string, workerId: string, epoch: number) {
  await transaction(async client => {
    const updated = await client.query(
      `UPDATE runs SET status='waiting_computer',lease_owner=NULL,lease_until=NULL,updated_at=now()
       WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_epoch=$3 RETURNING id`,
      [runId, workerId, epoch],
    );
    if (updated.rowCount) await addEvent(client, runId, "waiting_computer");
  });
}

export async function wakeComputerRuns() {
  await transaction(async client => {
    const waiting = await client.query<{ id: string }>(
      `SELECT id FROM runs WHERE status='waiting_computer' AND cancel_requested=false
       ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
    );
    for (const run of waiting.rows) {
      await client.query("UPDATE runs SET status='queued',updated_at=now() WHERE id=$1", [run.id]);
      await addEvent(client, run.id, "computer_ready");
    }
  });
}

export async function invalidateComputerPlans() {
  await transaction(async client => {
    const active = await client.query<{ id: string; status: string }>(
      `SELECT id,status FROM runs WHERE status IN ('queued','running','waiting_computer','waiting_approval')
       AND cancel_requested=false FOR UPDATE`,
    );
    for (const run of active.rows) {
      await client.query("UPDATE runs SET input_revision=input_revision+1,updated_at=now() WHERE id=$1", [run.id]);
      await client.query(
        "UPDATE approvals SET status='expired',decided_at=now() WHERE run_id=$1 AND status='pending'", [run.id],
      );
      await client.query(
        "UPDATE tool_calls SET status='failed',result=$2,updated_at=now() WHERE run_id=$1 AND status='waiting_approval'",
        [run.id, JSON.stringify({ error: "电脑接管后需重新规划操作" })],
      );
      if (run.status === "waiting_approval") await client.query(
        "UPDATE runs SET status='queued',updated_at=now() WHERE id=$1", [run.id],
      );
      await addEvent(client, run.id, "computer_control_changed");
    }
  });
}

export async function recoverExpiredRuns() {
  await transaction(async client => {
    const expired = await client.query<RunRow>(
      `SELECT * FROM runs WHERE (status IN ('running','canceling') AND lease_until<now()
       OR status='canceling' AND lease_owner IS NULL)
       ORDER BY lease_until LIMIT 20 FOR UPDATE SKIP LOCKED`,
    );
    for (const run of expired.rows) {
      const possibleEffect = await client.query(
        `SELECT 1 FROM tool_calls WHERE run_id=$1 AND status IN ('dispatching','unknown') LIMIT 1`,
        [run.id],
      );
      const status = possibleEffect.rowCount ? "reconciling" : run.cancel_requested ? "canceled" : "queued";
      await client.query(
        "UPDATE runs SET status=$2,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [run.id, status],
      );
      await addEvent(client, run.id, status, { reason: "lease_expired" });
      if (status === "canceled") await client.query(
        "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1", [run.id],
      );
    }
  });
}

export async function workerRunSnapshot(runId: string) {
  const result = await query<RunRow>("SELECT * FROM runs WHERE id=$1", [runId]);
  if (!result.rows[0]) throw new DomainError("找不到任务", 404, "run_not_found");
  return result.rows[0];
}

export async function runInputMessages(runId: string) {
  const result = await query<{ sequence: number; content: string }>(
    `SELECT ri.sequence,m.content FROM run_inputs ri
     JOIN messages m ON m.id=ri.message_id WHERE ri.run_id=$1 ORDER BY ri.sequence`, [runId],
  );
  return result.rows;
}

export async function workerConversationHistory(ownerId: string, conversationId: string, currentRunId: string) {
  const result = await query<{ role: Message["role"]; content: string }>(
    `SELECT role,content FROM messages WHERE owner_id=$1 AND conversation_id=$2
     AND (run_id IS NULL OR run_id<>$3) ORDER BY created_at,id LIMIT 100`,
    [ownerId, conversationId, currentRunId],
  );
  return result.rows;
}
