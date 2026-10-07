import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { query, transaction } from "./db.js";
import { DomainError } from "./errors.js";
import { approvalRequiredTools, toolInputSchemas, toolRegistry } from "./model.js";
import { addEvent } from "./runs.js";
import { hostRequest } from "./host-auth.js";
import { githubIssueApprovalTarget } from "./github-issues.js";
import type { ToolCallRecord } from "./tool-state.js";

type ApprovalRow = {
  id: string; run_id: string; call_id: string; target: string;
  args_hash: string; context_version: number; expires_at: Date;
  status: "pending" | "approved" | "rejected" | "expired";
  computer_generation: number | null; control_epoch: number | null;
  preview_artifact_id: string | null;
  preview_width: number | null; preview_height: number | null;
  name: string; args: Record<string, unknown>;
};

const observationSchema = z.object({
  observationId: z.uuid(), url: z.url(),
  elements: z.array(z.object({
    ref: z.string(), kind: z.enum(["link", "button", "textbox"]),
    label: z.string(), href: z.string().optional(),
  })),
});

export function browserApprovalTarget(call: Pick<ToolCallRecord, "name" | "args">, result: unknown): string | null {
  if (call.name !== "browser_click" && call.name !== "browser_fill") return null;
  const args = call.name === "browser_click"
    ? toolInputSchemas.browser_click.parse(call.args)
    : toolInputSchemas.browser_fill.parse(call.args);
  const observed = observationSchema.safeParse(result);
  if (!observed.success || observed.data.observationId !== args.observationId) return null;
  const element = observed.data.elements.find(item => item.ref === args.ref);
  if (!element || call.name === "browser_click" && element.kind === "textbox" ||
    call.name === "browser_fill" && element.kind !== "textbox") return null;
  const action = call.name === "browser_click" ? "点击" : "输入";
  return `网页${action}：${element.label || element.ref} (${observed.data.url})${element.href ? ` → ${element.href}` : ""}`;
}

function approval(row: ApprovalRow) {
  return {
    id: row.id, runId: row.run_id, callId: row.call_id,
    toolName: row.name, target: row.target, args: row.args,
    previewArtifactId: row.preview_artifact_id,
    previewWidth: row.preview_width, previewHeight: row.preview_height,
    expiresAt: row.expires_at.toISOString(), status: row.status,
  };
}

async function failExpiredRoutineApproval(client: PoolClient, runId: string): Promise<boolean> {
  const routine = await client.query(
    "SELECT 1 FROM routine_occurrences WHERE run_id=$1 LIMIT 1", [runId],
  );
  if (!routine.rowCount) return false;
  await client.query(
    `UPDATE runs SET status='failed',error='例程审批已过期，未自动批准',updated_at=now()
     WHERE id=$1 AND status='waiting_approval'`, [runId],
  );
  await client.query(
    `UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1
     WHERE active_run_id=$1`, [runId],
  );
  await addEvent(client, runId, "failed", { reason: "routine_approval_expired" });
  return true;
}

export async function listApprovals(ownerId: string) {
  const result = await query<ApprovalRow>(
    `SELECT a.*,c.name,c.args FROM approvals a JOIN tool_calls c ON c.id=a.call_id
     WHERE a.owner_id=$1 AND a.status='pending' ORDER BY a.created_at`, [ownerId],
  );
  return result.rows.map(approval);
}

export async function requestApproval(call: ToolCallRecord, input: {
  runId: string; workerId: string; epoch: number;
  computerGeneration?: number; controlEpoch?: number;
}) {
  if (!approvalRequiredTools.has(call.name)) throw new DomainError("工具不需要人工批准", 422, "approval_not_required");
  return transaction(async client => {
    const run = await client.query<{ owner_id: string; input_revision: number }>(
      `SELECT owner_id,input_revision FROM runs WHERE id=$1 AND status='running'
       AND cancel_requested=false AND lease_owner=$2 AND lease_epoch=$3 AND lease_until>now()
       FOR UPDATE`, [input.runId, input.workerId, input.epoch],
    );
    if (!run.rows[0]) throw new DomainError("任务执行权已失效", 409, "lease_lost");
    let target: string | null;
    let previewArtifactId: string | null = null;
    let previewWidth: number | null = null;
    let previewHeight: number | null = null;
    if (call.name === "shell_exec") {
      target = `/workspace $ ${toolInputSchemas.shell_exec.parse(call.args).command}`;
    } else if (call.name === "github_issue_create") {
      target = githubIssueApprovalTarget(call.args);
    } else if (["desktop_click", "desktop_key", "desktop_type"].includes(call.name)) {
      const args = call.args as { observationId?: string; x?: number; y?: number;
        button?: string; key?: string; text?: string };
      if (call.name === "desktop_click") toolInputSchemas.desktop_click.parse(call.args);
      else if (call.name === "desktop_key") toolInputSchemas.desktop_key.parse(call.args);
      else toolInputSchemas.desktop_type.parse(call.args);
      const observed = await client.query<{ result: unknown; updated_at: Date;
        screen_changed: boolean }>(
        `SELECT seen.result,seen.updated_at,EXISTS(
           SELECT 1 FROM tool_calls changed WHERE changed.run_id=$1
           AND changed.status='succeeded' AND changed.name=ANY($2::text[])
           AND changed.updated_at>seen.updated_at
         ) AS screen_changed
         FROM tool_calls seen WHERE seen.run_id=$1 AND seen.name='desktop_observe'
         AND seen.status='succeeded' ORDER BY seen.updated_at DESC,seen.id DESC LIMIT 1`,
        [input.runId, ["browser_open", "browser_click", "browser_fill", "desktop_click",
          "desktop_key", "desktop_type", "shell_exec"]],
      );
      const snapshot = toolRegistry.desktop_observe.resultSchema.safeParse(observed.rows[0]?.result);
      const valid = snapshot.success &&
        snapshot.data.observationId === args.observationId && !observed.rows[0].screen_changed &&
        Date.now() - observed.rows[0].updated_at.getTime() <= 120_000 &&
        snapshot.data.generation === input.computerGeneration &&
        snapshot.data.controlEpoch === input.controlEpoch &&
        (call.name !== "desktop_click" || args.x !== undefined && args.y !== undefined &&
          args.x < snapshot.data.width && args.y < snapshot.data.height);
      if (valid && snapshot.success) {
        previewArtifactId = snapshot.data.artifactId;
        previewWidth = snapshot.data.width;
        previewHeight = snapshot.data.height;
        target = call.name === "desktop_click"
          ? `桌面${args.button === "right" ? "右键" : args.button === "double" ? "双击" : "左键"}：(${args.x}, ${args.y})，截图 ${args.observationId?.slice(0, 8)}`
          : call.name === "desktop_key"
            ? `桌面按键：${args.key}，截图 ${args.observationId?.slice(0, 8)}`
            : `桌面粘贴：${args.text?.length ?? 0} 字符，截图 ${args.observationId?.slice(0, 8)}`;
      } else target = null;
    } else {
      const observed = await client.query<{ result: unknown }>(
        `SELECT result FROM tool_calls WHERE run_id=$1 AND name='browser_read' AND status='succeeded'
         ORDER BY updated_at DESC,id DESC LIMIT 1`, [input.runId],
      );
      target = browserApprovalTarget(call, observed.rows[0]?.result);
    }
    if (!target) {
      await client.query(
        "UPDATE tool_calls SET status='failed',result=$2,updated_at=now() WHERE id=$1 AND status='proposed'",
        [call.id, JSON.stringify({ error: "观察已失效，请重新获取页面或桌面截图" })],
      );
      await addEvent(client, input.runId, "tool_failed", { callId: call.id, reason: "stale_observation" });
      return null;
    }
    const updated = await client.query(
      `UPDATE tool_calls SET status='waiting_approval',updated_at=now()
       WHERE id=$1 AND run_id=$2 AND status='proposed' RETURNING id`,
      [call.id, input.runId],
    );
    if (!updated.rowCount) throw new DomainError("工具调用状态已变化", 409, "call_changed");
    const id = randomUUID();
    await client.query(
      `INSERT INTO approvals(id,owner_id,run_id,call_id,target,args_hash,context_version,
       computer_generation,control_epoch,preview_artifact_id,preview_width,preview_height,expires_at,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+($13::int * interval '1 second'),'pending')`,
      [id, run.rows[0].owner_id, input.runId, call.id,
        target, call.argsHash, run.rows[0].input_revision,
        input.computerGeneration, input.controlEpoch, previewArtifactId, previewWidth, previewHeight,
        previewArtifactId ? 120 : 600],
    );
    await client.query(
      `UPDATE runs SET status='waiting_approval',lease_owner=NULL,lease_until=NULL,updated_at=now()
       WHERE id=$1`, [input.runId],
    );
    await addEvent(client, input.runId, "approval_requested", { approvalId: id, callId: call.id });
    return id;
  });
}

export async function decideApproval(ownerId: string, id: string, decision: "approve" | "reject") {
  const binding = await query<{ computer_generation: number | null }>(
    "SELECT computer_generation FROM approvals WHERE owner_id=$1 AND id=$2", [ownerId, id],
  );
  const computer = decision === "approve" && binding.rows[0]?.computer_generation != null
    ? (await hostRequest<{ computer: {
    status: string; controlMode: string; generation: number; controlEpoch: number;
  } }>("/state", {}, 4000)).computer : null;
  const decided = await transaction(async client => {
    const lookup = await client.query<{ run_id: string }>(
      "SELECT run_id FROM approvals WHERE owner_id=$1 AND id=$2", [ownerId, id],
    );
    if (!lookup.rows[0]) throw new DomainError("找不到审批", 404, "approval_not_found");
    const run = await client.query<{ status: string; input_revision: number; cancel_requested: boolean }>(
      "SELECT status,input_revision,cancel_requested FROM runs WHERE id=$1 FOR UPDATE", [lookup.rows[0].run_id],
    );
    const found = await client.query<ApprovalRow>(
      `SELECT a.*,c.name,c.args FROM approvals a JOIN tool_calls c ON c.id=a.call_id
       WHERE a.owner_id=$1 AND a.id=$2 FOR UPDATE OF a,c`, [ownerId, id],
    );
    const item = found.rows[0];
    if (item.status !== "pending") throw new DomainError("审批已处理或失效", 409, "approval_closed");
    const valid = run.rows[0]?.status === "waiting_approval" && !run.rows[0].cancel_requested &&
      run.rows[0].input_revision === item.context_version && item.expires_at.getTime() > Date.now() &&
      (decision === "reject" || item.computer_generation === null && item.control_epoch === null ||
      computer?.status === "ready" && computer.controlMode === "agent" &&
      item.computer_generation === computer.generation && item.control_epoch === computer.controlEpoch);
    const status = valid ? decision === "approve" ? "approved" : "rejected" : "expired";
    await client.query(
      "UPDATE approvals SET status=$2,decided_at=now() WHERE id=$1", [id, status],
    );
    await client.query(
      `UPDATE tool_calls SET status=$2,result=CASE WHEN $2='failed' THEN $3::jsonb ELSE result END,
       updated_at=now() WHERE id=$1`,
      [item.call_id, status === "approved" ? "authorized" : "failed",
        JSON.stringify({ error: status === "rejected" ? "用户拒绝执行命令" : "审批已失效" })],
    );
    if (run.rows[0]?.status === "waiting_approval" &&
      !(status === "expired" && item.expires_at.getTime() <= Date.now() &&
        await failExpiredRoutineApproval(client, item.run_id))) await client.query(
      "UPDATE runs SET status='queued',updated_at=now() WHERE id=$1", [item.run_id],
    );
    await addEvent(client, item.run_id, `approval_${status}`, { approvalId: id, callId: item.call_id });
    return { value: approval({ ...item, status }), valid };
  });
  if (!decided.valid) throw new DomainError("审批已过期或任务状态已变化", 409, "approval_expired");
  return decided.value;
}

export async function expireApprovals() {
  const stale = await query<{ id: string; run_id: string }>(
      `SELECT a.id,a.run_id,a.call_id,a.status FROM approvals a
       JOIN tool_calls c ON c.id=a.call_id
       WHERE a.status IN ('pending','approved') AND a.expires_at<=now()
       AND c.status IN ('waiting_approval','authorized')
       ORDER BY a.expires_at LIMIT 30`,
  );
  for (const item of stale.rows) {
    await transaction(async client => {
      const run = await client.query<{ status: string }>(
        "SELECT status FROM runs WHERE id=$1 FOR UPDATE", [item.run_id],
      );
      const approval = await client.query<{ call_id: string }>(
        `SELECT a.call_id FROM approvals a JOIN tool_calls c ON c.id=a.call_id
         WHERE a.id=$1 AND a.status IN ('pending','approved') AND a.expires_at<=now()
         AND c.status IN ('waiting_approval','authorized') FOR UPDATE OF a,c`, [item.id],
      );
      if (!approval.rows[0]) return;
      await client.query("UPDATE approvals SET status='expired',decided_at=now() WHERE id=$1", [item.id]);
      await client.query(
        "UPDATE tool_calls SET status='failed',result=$2,updated_at=now() WHERE id=$1",
        [approval.rows[0].call_id, JSON.stringify({ error: "审批已过期" })],
      );
      if (run.rows[0]?.status === "waiting_approval") {
        if (!await failExpiredRoutineApproval(client, item.run_id)) await client.query(
          "UPDATE runs SET status='queued',updated_at=now() WHERE id=$1", [item.run_id],
        );
      }
      await addEvent(client, item.run_id, "approval_expired", { approvalId: item.id });
    });
  }
}
