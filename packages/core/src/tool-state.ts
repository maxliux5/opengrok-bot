import { createHash, randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { RunBudget, ShellCommand, ToolCapability } from "@opengrok/contracts";
import { canonicalJson } from "@opengrok/contracts";
import { query, transaction } from "./db.js";
import { addEvent } from "./runs.js";
import { DomainError } from "./errors.js";
import { approvalRequiredTools, toolRegistry, type AgentToolName } from "./model.js";

export type ToolCallRecord = {
  id: string; operationId: string; stepId: string; ordinal: number;
  name: AgentToolName; args: unknown; argsHash: string;
  status: "proposed" | "waiting_approval" | "authorized" | "dispatching" | "succeeded" | "failed" | "unknown";
  replayPolicy: "idempotent" | "reconcile_before_retry" | "manual_only";
  result: unknown;
};

export async function listShellCommands(ownerId: string, runId: string): Promise<ShellCommand[]> {
  const result = await query<{
    operation_id: string; args: { command: string; timeoutMs?: number };
    status: ShellCommand["status"]; stop_requested_at: Date | null;
    result: ShellCommand["result"]; created_at: Date; updated_at: Date;
  }>(
    `SELECT c.operation_id,c.args,c.status,c.stop_requested_at,c.result,c.created_at,c.updated_at
     FROM tool_calls c JOIN runs r ON r.id=c.run_id
     WHERE c.run_id=$1 AND r.owner_id=$2 AND c.name='shell_exec'
     ORDER BY c.created_at,c.id`, [runId, ownerId],
  );
  return result.rows.map(row => ({ operationId: row.operation_id,
    command: row.args.command, timeoutMs: row.args.timeoutMs ?? 10_000,
    status: row.status, stopRequestedAt: row.stop_requested_at?.toISOString() ?? null,
    result: row.result, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString() }));
}

export async function requestShellStop(ownerId: string, runId: string, operationId: string) {
  return transaction(async client => {
    const run = await client.query(
      "SELECT id FROM runs WHERE id=$1 AND owner_id=$2 FOR UPDATE", [runId, ownerId],
    );
    if (!run.rowCount) throw new DomainError("任务不存在", 404, "run_not_found");
    const call = await client.query<{ status: string; stop_requested_at: Date | null }>(
      `SELECT status,stop_requested_at FROM tool_calls
       WHERE run_id=$1 AND operation_id=$2 AND name='shell_exec' FOR UPDATE`,
      [runId, operationId],
    );
    if (!call.rowCount) throw new DomainError("终端命令不存在", 404, "shell_command_not_found");
    if (!["dispatching", "unknown"].includes(call.rows[0].status)) {
      throw new DomainError("终端命令尚未执行或已有确定回执", 409, "shell_not_running");
    }
    if (!call.rows[0].stop_requested_at) {
      await client.query(
        "UPDATE tool_calls SET stop_requested_at=now(),updated_at=now() WHERE run_id=$1 AND operation_id=$2",
        [runId, operationId],
      );
      await addEvent(client, runId, "shell_stop_requested", { operationId });
    }
    return { operationId, status: call.rows[0].status, stopRequested: true };
  });
}

type ToolCallRow = {
  id: string; operation_id: string; step_id: string; ordinal: number;
  name: AgentToolName; args: unknown; args_hash: string;
  status: ToolCallRecord["status"]; replay_policy: ToolCallRecord["replayPolicy"];
  result: unknown;
};

function toCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id, operationId: row.operation_id, stepId: row.step_id,
    ordinal: row.ordinal, name: row.name, args: row.args, argsHash: row.args_hash,
    status: row.status, replayPolicy: row.replay_policy, result: row.result,
  };
}

export async function beginModelStep(runId: string, workerId: string, epoch: number,
  inputRevision: number, consumedInputSequence: number,
  messages: ModelMessage[]): Promise<{ stepId: string; ordinal: number }> {
  return transaction(async client => {
    const locked = await client.query<{ id: string; input_revision: number; budget_json: RunBudget }>(
      `SELECT id,input_revision,budget_json FROM runs WHERE id=$1 AND lease_owner=$2 AND lease_epoch=$3
       AND status='running' AND cancel_requested=false FOR UPDATE`, [runId, workerId, epoch],
    );
    if (!locked.rows[0] || locked.rows[0].input_revision !== inputRevision) {
      throw new DomainError("任务输入或执行权已变化", 409, "run_changed");
    }
    const count = await client.query<{ used: number; next: number }>(
      "SELECT COUNT(*)::int AS used,COALESCE(MAX(ordinal),0)+1 AS next FROM model_steps WHERE run_id=$1", [runId],
    );
    if (count.rows[0].used >= locked.rows[0].budget_json.maxModelSteps) {
      throw new DomainError("任务达到模型步骤上限，尚未完成验收", 409, "budget_exceeded");
    }
    const ordinal = count.rows[0].next;
    const stepId = randomUUID();
    await client.query(
      `INSERT INTO model_steps(id,run_id,ordinal,input_revision,consumed_input_sequence,
       model_profile_id,status,input_snapshot)
       SELECT $1,id,$2,$3,$4,model_profile_id,'started',$5 FROM runs WHERE id=$6`,
      [stepId, ordinal, inputRevision, consumedInputSequence, JSON.stringify(messages), runId],
    );
    await addEvent(client, runId, "model_step_started", { stepId, ordinal });
    return { stepId, ordinal };
  });
}

export async function recordModelStepPartial(input: {
  runId: string; stepId: string; workerId: string; epoch: number;
  inputRevision: number; text: string;
}): Promise<boolean> {
  return transaction(async client => {
    const run = await client.query(
      `SELECT 1 FROM runs WHERE id=$1 AND status IN ('running','canceling')
       AND lease_owner=$2 AND lease_epoch=$3 AND input_revision=$4 FOR UPDATE`,
      [input.runId, input.workerId, input.epoch, input.inputRevision],
    );
    if (!run.rowCount) return false;
    const updated = await client.query(
      `UPDATE model_steps SET output_snapshot=$3
       WHERE id=$1 AND run_id=$2 AND status='started' RETURNING id`,
      [input.stepId, input.runId, JSON.stringify({ text: input.text.slice(0, 20_000), partial: true })],
    );
    if (!updated.rowCount) return false;
    await addEvent(client, input.runId, "model_step_partial", {
      stepId: input.stepId, length: input.text.length,
    });
    return true;
  });
}

export async function getRunPartial(ownerId: string, runId: string) {
  const result = await query<{ status: string; text: string | null }>(
    `SELECT s.status,s.output_snapshot->>'text' AS text FROM model_steps s
     JOIN runs r ON r.id=s.run_id WHERE s.run_id=$1 AND r.owner_id=$2
     ORDER BY s.ordinal DESC LIMIT 1`, [runId, ownerId],
  );
  const step = result.rows[0];
  return step && ["started", "interrupted"].includes(step.status)
    ? { status: step.status, text: step.text || "" }
    : { status: null, text: "" };
}

export async function completeModelStep(input: {
  runId: string; stepId: string; workerId: string; epoch: number;
  inputRevision: number; text: string; responseMessages: ModelMessage[];
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  usage: unknown; estimatedInputBytes?: number;
}): Promise<"completed" | "obsolete" | "lost"> {
  return transaction(async client => {
    const locked = await client.query<{ status: string; input_revision: number; lease_owner: string | null; lease_epoch: string; cancel_requested: boolean }>(
      "SELECT status,input_revision,lease_owner,lease_epoch,cancel_requested FROM runs WHERE id=$1 FOR UPDATE",
      [input.runId],
    );
    const run = locked.rows[0];
    if (!run || run.status !== "running" || run.cancel_requested ||
      run.lease_owner !== input.workerId || Number(run.lease_epoch) !== input.epoch) return "lost";

    const snapshot = { text: input.text, responseMessages: input.responseMessages, toolCalls: input.toolCalls };
    const obsolete = run.input_revision !== input.inputRevision;
    const step = await client.query<{ input_snapshot: ModelMessage[] }>(
      "SELECT input_snapshot FROM model_steps WHERE id=$1 AND run_id=$2 FOR UPDATE",
      [input.stepId, input.runId],
    );
    if (!step.rows[0]) return "lost";
    const reported = (input.usage as { totalTokens?: unknown } | null)?.totalTokens;
    const estimated = typeof reported !== "number" || !Number.isSafeInteger(reported) || reported <= 0;
    const meteredTokens = estimated
      ? Buffer.byteLength(JSON.stringify(step.rows[0].input_snapshot)) +
        Buffer.byteLength(JSON.stringify(snapshot)) + (input.estimatedInputBytes ?? 0)
      : reported;
    const usage = { ...(input.usage && typeof input.usage === "object" ? input.usage : {}),
      budgetedTokens: meteredTokens, estimated };
    await client.query(
      `UPDATE model_steps SET status=$2,output_snapshot=$3,usage_json=$4,completed_at=now()
       WHERE id=$1 AND run_id=$5`,
      [input.stepId, obsolete ? "obsolete" : "completed", JSON.stringify(snapshot),
        JSON.stringify(usage), input.runId],
    );
    await client.query(
      `UPDATE runs SET token_count=token_count+$2,
       token_usage_estimated=token_usage_estimated OR $3 WHERE id=$1`,
      [input.runId, meteredTokens, estimated],
    );
    if (obsolete) {
      await client.query(
        "UPDATE runs SET status='queued',lease_owner=NULL,lease_until=NULL WHERE id=$1", [input.runId],
      );
      await addEvent(client, input.runId, "requeued_for_input");
      return "obsolete";
    }
    for (const [ordinal, call] of input.toolCalls.entries()) {
      if (!Object.hasOwn(toolRegistry, call.toolName)) {
        throw new DomainError(`未注册的工具：${call.toolName}`, 422, "unknown_tool");
      }
      const replayPolicy = toolRegistry[call.toolName as AgentToolName].replayPolicy;
      const argsHash = createHash("sha256").update(canonicalJson(call.input)).digest("hex");
      await client.query(
        `INSERT INTO tool_calls(id,run_id,step_id,operation_id,ordinal,name,args,args_hash,status,replay_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'proposed',$9)`,
        [randomUUID(), input.runId, input.stepId, randomUUID(), ordinal,
          call.toolName, JSON.stringify(call.input), argsHash, replayPolicy],
      );
    }
    await addEvent(client, input.runId, "model_step_completed", {
      stepId: input.stepId, toolCount: input.toolCalls.length,
    });
    return "completed";
  });
}

export async function interruptModelStep(stepId: string, runId: string, reason: string) {
  await transaction(async client => {
    const changed = await client.query(
      `UPDATE model_steps SET status='interrupted',completed_at=now()
       WHERE id=$1 AND run_id=$2 AND status='started' RETURNING id`, [stepId, runId],
    );
    if (changed.rowCount) await addEvent(client, runId, "model_step_interrupted", { stepId, reason });
  });
}

export async function callsForStep(stepId: string): Promise<ToolCallRecord[]> {
  const result = await query<ToolCallRow>(
    "SELECT * FROM tool_calls WHERE step_id=$1 ORDER BY ordinal", [stepId],
  );
  return result.rows.map(toCall);
}

export async function authorizeCall(callId: string, runId: string, workerId: string, epoch: number) {
  return transaction(async client => {
    const run = await client.query<{ id: string }>(
      `SELECT id FROM runs WHERE id=$1 AND status='running' AND cancel_requested=false
       AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now() FOR UPDATE`,
      [runId, workerId, epoch],
    );
    if (!run.rows[0]) throw new DomainError("任务执行权已失效", 409, "lease_lost");
    const updated = await client.query<ToolCallRow>(
      `UPDATE tool_calls SET status='authorized',updated_at=now()
       WHERE id=$1 AND run_id=$2 AND status='proposed' RETURNING *`, [callId, runId],
    );
    if (!updated.rows[0]) throw new DomainError("工具调用状态已变化", 409, "call_changed");
    await addEvent(client, runId, "tool_authorized", { callId, name: updated.rows[0].name });
    return toCall(updated.rows[0]);
  });
}

export async function rejectDeniedCall(callId: string, runId: string, workerId: string, epoch: number) {
  await transaction(async client => {
    const run = await client.query(
      `SELECT 1 FROM runs WHERE id=$1 AND status='running' AND cancel_requested=false
       AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now() FOR UPDATE`,
      [runId, workerId, epoch],
    );
    if (!run.rowCount) throw new DomainError("任务执行权已失效", 409, "lease_lost");
    const updated = await client.query<{ name: AgentToolName }>(
      `UPDATE tool_calls SET status='failed',result=$3,updated_at=now()
       WHERE id=$1 AND run_id=$2 AND status IN ('proposed','authorized','waiting_approval')
       RETURNING name`, [callId, runId, JSON.stringify({ error: "Bot 未授权此工具能力，工具未执行" })],
    );
    if (!updated.rows[0]) throw new DomainError("工具调用状态已变化", 409, "call_changed");
    await client.query(
      `UPDATE approvals SET status='expired',decided_at=now()
       WHERE call_id=$1 AND status='pending'`, [callId],
    );
    await addEvent(client, runId, "tool_denied", { callId, name: updated.rows[0].name });
  });
}

export async function markCallDispatching(callId: string, runId: string, workerId: string, epoch: number) {
  return transaction(async client => {
    const run = await client.query<{ tool_count: number; token_count: number;
      budget_json: RunBudget; capabilities_json: ToolCapability[]; bot_id: string; created_at: Date }>(
      `SELECT tool_count,token_count,budget_json,capabilities_json,bot_id,created_at FROM runs
       WHERE id=$1 AND status='running' AND cancel_requested=false
       AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now() FOR UPDATE`,
      [runId, workerId, epoch],
    );
    if (!run.rowCount) throw new DomainError("任务执行权已失效", 409, "lease_lost");
    if (run.rows[0].tool_count >= run.rows[0].budget_json.maxToolCalls) {
      throw new DomainError("任务达到工具次数预算", 409, "budget_exceeded");
    }
    if (run.rows[0].token_count >= run.rows[0].budget_json.maxTokens ||
      Date.now() - run.rows[0].created_at.getTime() >= run.rows[0].budget_json.maxWallMs) {
      throw new DomainError("任务达到模型 token 或总时长预算", 409, "budget_exceeded");
    }
    const updated = await client.query<ToolCallRow>(
      `UPDATE tool_calls SET status='dispatching',updated_at=now()
       WHERE id=$1 AND run_id=$2 AND status='authorized' RETURNING *`, [callId, runId],
    );
    if (!updated.rows[0]) throw new DomainError("工具调用状态已变化", 409, "call_changed");
    const capability = toolRegistry[updated.rows[0].name].capability;
    const bot = await client.query<{ capabilities_json: ToolCapability[] }>(
      "SELECT capabilities_json FROM bots WHERE id=$1 FOR SHARE", [run.rows[0].bot_id],
    );
    if (!run.rows[0].capabilities_json.includes(capability) ||
      !bot.rows[0]?.capabilities_json.includes(capability)) {
      throw new DomainError("Bot 未授权此工具能力", 403, "capability_denied");
    }
    if (approvalRequiredTools.has(updated.rows[0].name)) {
      const approved = await client.query(
        `SELECT 1 FROM approvals a JOIN runs r ON r.id=a.run_id
         WHERE a.call_id=$1 AND a.run_id=$2 AND a.status='approved'
         AND a.args_hash=$3 AND a.context_version=r.input_revision
         AND a.expires_at>now()`,
        [callId, runId, updated.rows[0].args_hash],
      );
      if (!approved.rowCount) throw new DomainError("命令批准已失效", 409, "approval_expired");
    }
    await addEvent(client, runId, "tool_dispatching", { callId });
    return toCall(updated.rows[0]);
  });
}

export async function recordCallResult(callId: string, runId: string, workerId: string, epoch: number,
  outcome: "succeeded" | "failed" | "unknown", result: unknown) {
  await transaction(async client => {
    const run = await client.query(
      `SELECT 1 FROM runs WHERE id=$1 AND status IN ('running','canceling') AND lease_owner=$2
       AND lease_epoch=$3 AND lease_until>now() FOR UPDATE`,
      [runId, workerId, epoch],
    );
    if (!run.rowCount) throw new DomainError("任务执行权已失效", 409, "lease_lost");
    const updated = await client.query(
      `UPDATE tool_calls SET status=$3,result=$4,updated_at=now()
       WHERE id=$1 AND run_id=$2 AND status='dispatching' RETURNING id`,
      [callId, runId, outcome, JSON.stringify(result)],
    );
    if (!updated.rowCount) return;
    await client.query("UPDATE runs SET tool_count=tool_count+1 WHERE id=$1", [runId]);
    if (outcome === "unknown") {
      await client.query(
        "UPDATE runs SET status='reconciling',lease_owner=NULL,lease_until=NULL WHERE id=$1", [runId],
      );
    }
    await addEvent(client, runId, `tool_${outcome}`, { callId, result });
  });
}

export async function completedSteps(runId: string) {
  const result = await query<{
    id: string; ordinal: number; input_revision: number; consumed_input_sequence: number; input_snapshot: ModelMessage[];
    output_snapshot: { text: string; responseMessages: ModelMessage[]; toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> };
  }>(
    `SELECT id,ordinal,input_revision,consumed_input_sequence,input_snapshot,output_snapshot FROM model_steps
     WHERE run_id=$1 AND status='completed' ORDER BY ordinal`, [runId],
  );
  return result.rows;
}

export async function interruptStartedSteps(runId: string) {
  await transaction(async client => {
    const changed = await client.query<{ id: string }>(
      `UPDATE model_steps SET status='interrupted',completed_at=now()
       WHERE run_id=$1 AND status='started' RETURNING id`, [runId],
    );
    for (const row of changed.rows) {
      await addEvent(client, runId, "model_step_interrupted", { stepId: row.id, reason: "worker_restarted" });
    }
  });
}

export async function invalidateUnsentCalls(runId: string, stepId: string) {
  await transaction(async client => {
    const changed = await client.query(
      `UPDATE tool_calls SET status='failed',result=$3,updated_at=now()
       WHERE run_id=$1 AND step_id=$2 AND status IN ('proposed','authorized','waiting_approval') RETURNING id`,
      [runId, stepId, JSON.stringify({ error: "用户补充了新要求，旧步骤未执行" })],
    );
    if (changed.rowCount) await addEvent(client, runId, "pending_tools_invalidated", { stepId, count: changed.rowCount });
  });
}

export async function pendingReconciliation(): Promise<Array<{
  runId: string; ownerId: string; botId: string; call: ToolCallRecord;
}>> {
  const result = await query<ToolCallRow & { run_id: string; owner_id: string; bot_id: string }>(
    `SELECT c.*,r.owner_id,r.bot_id FROM tool_calls c JOIN runs r ON r.id=c.run_id
     WHERE r.status='reconciling' AND c.status IN ('dispatching','unknown')
     ORDER BY c.updated_at LIMIT 30`,
  );
  return result.rows.map(row => ({ runId: row.run_id, ownerId: row.owner_id,
    botId: row.bot_id, call: toCall(row) }));
}

export async function resolveReconciledCall(runId: string, callId: string,
  outcome: "succeeded" | "failed", result: unknown) {
  await transaction(async client => {
    const run = await client.query<{ status: string; cancel_requested: boolean }>(
      "SELECT status,cancel_requested FROM runs WHERE id=$1 FOR UPDATE", [runId],
    );
    if (run.rows[0]?.status !== "reconciling") return;
    const call = await client.query<{ status: string }>(
      `SELECT status FROM tool_calls WHERE id=$1 AND run_id=$2
       AND status IN ('dispatching','unknown') FOR UPDATE`, [callId, runId],
    );
    if (!call.rows[0]) return;
    const updated = await client.query(
      `UPDATE tool_calls SET status=$3,result=$4,updated_at=now()
       WHERE id=$1 AND run_id=$2 AND status IN ('dispatching','unknown') RETURNING id`,
      [callId, runId, outcome, JSON.stringify(result)],
    );
    if (!updated.rowCount) return;
    if (call.rows[0].status === "dispatching") await client.query(
      "UPDATE runs SET tool_count=tool_count+1 WHERE id=$1", [runId],
    );
    await addEvent(client, runId, "tool_reconciled", { callId, outcome });
    const remaining = await client.query(
      "SELECT 1 FROM tool_calls WHERE run_id=$1 AND status IN ('dispatching','unknown') LIMIT 1", [runId],
    );
    if (remaining.rowCount) return;
    const status = run.rows[0].cancel_requested ? "canceled" : "queued";
    await client.query(
      "UPDATE runs SET status=$2,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1", [runId, status],
    );
    if (status === "canceled") await client.query(
      "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1", [runId],
    );
    await addEvent(client, runId, status, { reason: "effects_reconciled" });
  });
}
