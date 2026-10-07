import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { HandoffLink, HandoffTaskInput, Run, RunBudget, RunStatus, ToolCapability } from "@opengrok/contracts";
import { canonicalJson } from "@opengrok/contracts";
import { resolveArtifactPath } from "./artifact-path.js";
import { query, transaction } from "./db.js";
import { DomainError } from "./errors.js";
import { addEvent, getRun } from "./runs.js";
import { snapshotBoundSkills } from "./skills.js";

const maxDepth = 2;
const maxDescendants = 3;
const cumulativeFields = ["maxModelSteps", "maxToolCalls", "maxTokens", "maxWallMs"] as const;

type ParentRow = {
  id: string; owner_id: string; bot_id: string; root_run_id: string | null;
  delegation_depth: number; status: RunStatus; cancel_requested: boolean;
  lease_owner: string | null; lease_epoch: string; lease_until: Date | null;
  budget_json: RunBudget; capabilities_json: ToolCapability[];
};
type BotRow = { id: string; name: string; model_profile_id: string | null;
  capabilities_json: ToolCapability[] };
type ExistingRow = { id: string; owner_id: string; parent_run_id: string;
  delegation_args_hash: string; delegation_source: "user" | "agent";
  conversation_id: string; bot_id: string };
type LinkRow = { id: string; bot_id: string; bot_name: string; conversation_id: string;
  status: RunStatus; handoff_task: string; handoff_acceptance: string;
  delegation_depth: number; created_at: Date };

function childBudget(parent: RunBudget): RunBudget {
  return {
    maxModelSteps: Math.max(1, Math.floor(parent.maxModelSteps / 2)),
    maxToolCalls: Math.max(1, Math.floor(parent.maxToolCalls / 2)),
    maxTokens: Math.max(1, Math.floor(parent.maxTokens / 2)),
    maxWallMs: Math.max(1000, Math.floor(parent.maxWallMs / 2)),
    maxModelCallMs: parent.maxModelCallMs,
    maxModelOutputTokens: parent.maxModelOutputTokens,
    maxArtifactBytes: parent.maxArtifactBytes,
  };
}

export async function createHandoff(ownerId: string, parentRunId: string, operationId: string,
  source: "user" | "agent", input: HandoffTaskInput,
  execution?: { workerId: string; epoch: number; callId: string; argsHash: string }):
  Promise<{ run: Run; conversationId: string; targetBotId: string }> {
  const argsHash = execution?.argsHash ||
    createHash("sha256").update(canonicalJson(input)).digest("hex");
  const childId = await transaction(async client => {
    const parentRef = await client.query<{ root_run_id: string | null }>(
      "SELECT root_run_id FROM runs WHERE owner_id=$1 AND id=$2", [ownerId, parentRunId]);
    if (!parentRef.rows[0]) throw new DomainError("找不到上游任务", 404, "run_not_found");
    const rootId = parentRef.rows[0].root_run_id || parentRunId;
    const rootResult = await client.query<ParentRow>(
      "SELECT * FROM runs WHERE owner_id=$1 AND id=$2 FOR UPDATE", [ownerId, rootId]);
    const root = rootResult.rows[0];
    if (!root) throw new DomainError("找不到任务根节点", 409, "handoff_root_missing");

    const previous = await client.query<ExistingRow>(
      "SELECT * FROM runs WHERE delegation_operation_id=$1", [operationId]);
    if (previous.rows[0]) {
      const old = previous.rows[0];
      if (old.owner_id !== ownerId || old.parent_run_id !== parentRunId ||
        old.delegation_args_hash !== argsHash || old.delegation_source !== source) {
        throw new DomainError("交接请求 ID 对应了不同内容", 409, "handoff_request_conflict");
      }
      return old.id;
    }

    const parent = rootId === parentRunId ? root : (await client.query<ParentRow>(
      "SELECT * FROM runs WHERE owner_id=$1 AND id=$2 FOR UPDATE", [ownerId, parentRunId])).rows[0];
    if (!parent) throw new DomainError("找不到上游任务", 404, "run_not_found");
    if (["failed", "canceled", "canceling", "reconciling"].includes(parent.status) ||
      parent.cancel_requested) {
      throw new DomainError("当前任务状态不能发起交接", 409, "handoff_parent_unavailable");
    }
    if (source === "agent") {
      if (!execution || parent.status !== "running" ||
        parent.lease_owner !== execution.workerId || Number(parent.lease_epoch) !== execution.epoch ||
        !parent.lease_until || parent.lease_until <= new Date() ||
        !parent.capabilities_json.includes("delegate")) {
        throw new DomainError("交接执行权已失效", 409, "handoff_lease_lost");
      }
      const call = await client.query(
        `SELECT 1 FROM tool_calls WHERE id=$1 AND run_id=$2 AND operation_id=$3
         AND name='delegate_to_bot' AND status='dispatching'`,
        [execution.callId, parentRunId, operationId]);
      const currentBot = await client.query<{ capabilities_json: ToolCapability[] }>(
        "SELECT capabilities_json FROM bots WHERE owner_id=$1 AND id=$2", [ownerId, parent.bot_id]);
      if (!call.rowCount || !currentBot.rows[0]?.capabilities_json.includes("delegate")) {
        throw new DomainError("Bot 未授权交接能力", 403, "handoff_capability_denied");
      }
    }
    if (parent.delegation_depth >= maxDepth) {
      throw new DomainError("交接已达到最大深度", 409, "handoff_depth_exceeded");
    }
    const target = (await client.query<BotRow>(
      "SELECT * FROM bots WHERE owner_id=$1 AND id=$2", [ownerId, input.targetBotId])).rows[0];
    if (!target || !target.model_profile_id) {
      throw new DomainError("目标 Bot 不存在或尚未配置模型", 422, "handoff_target_unavailable");
    }
    const ancestors = await client.query<{ bot_id: string }>(
      `WITH RECURSIVE chain AS (
         SELECT id,parent_run_id,bot_id FROM runs WHERE id=$1
         UNION ALL
         SELECT r.id,r.parent_run_id,r.bot_id FROM runs r JOIN chain c ON r.id=c.parent_run_id
       ) SELECT bot_id FROM chain`, [parentRunId]);
    if (ancestors.rows.some(row => row.bot_id === target.id)) {
      throw new DomainError("交接不能回到自身或祖先 Bot", 409, "handoff_cycle");
    }
    if (input.deliverable === "report" &&
      (!target.capabilities_json.includes("public_web") ||
        !target.capabilities_json.includes("artifact"))) {
      throw new DomainError("目标 Bot 缺少报告所需能力", 403, "handoff_report_capability_denied");
    }
    if (input.artifactIds.length && !target.capabilities_json.includes("artifact")) {
      throw new DomainError("目标 Bot 没有成果读取能力", 403, "handoff_artifact_capability_denied");
    }

    const refs = input.artifactIds.length ? await client.query<{
      id: string; title: string; mime_type: string;
    }>(
      `SELECT a.id,a.title,a.mime_type FROM artifacts a
       WHERE a.owner_id=$1 AND a.id=ANY($2::uuid[]) AND
       (a.run_id=$3 OR EXISTS (
         SELECT 1 FROM run_handoff_artifacts ref
         WHERE ref.child_run_id=$3 AND ref.artifact_id=a.id))`,
      [ownerId, input.artifactIds, parentRunId]) : { rows: [] };
    if (refs.rows.length !== input.artifactIds.length ||
      refs.rows.some(item => item.mime_type !== "text/markdown; charset=utf-8")) {
      throw new DomainError("只能交接当前任务可访问的 Markdown 成果", 403, "handoff_artifact_denied");
    }

    const allocated = await client.query<{ descendants: string; budget: RunBudget }>(
      `SELECT (count(*)-1)::text AS descendants,
       jsonb_build_object(
         'maxModelSteps',sum((budget_json->>'maxModelSteps')::bigint),
         'maxToolCalls',sum((budget_json->>'maxToolCalls')::bigint),
         'maxTokens',sum((budget_json->>'maxTokens')::bigint),
         'maxWallMs',sum((budget_json->>'maxWallMs')::bigint)) AS budget
       FROM runs WHERE owner_id=$1 AND (id=$2 OR root_run_id=$2)`, [ownerId, rootId]);
    const row = allocated.rows[0];
    if (Number(row.descendants) >= maxDescendants) {
      throw new DomainError("交接已达到子任务数量上限", 409, "handoff_count_exceeded");
    }
    const budget = childBudget(parent.budget_json);
    if (cumulativeFields.some(field => Number(row.budget[field]) + budget[field] >
      root.budget_json[field] * 2)) {
      throw new DomainError("交接已达到任务树累计预算", 409, "handoff_budget_exceeded");
    }

    const conversationId = randomUUID();
    const runId = randomUUID();
    const messageId = randomUUID();
    const parentBot = (await client.query<{ name: string }>(
      "SELECT name FROM bots WHERE id=$1", [parent.bot_id])).rows[0];
    const sources = refs.rows.map(item => `- ${item.title}：${item.id}`).join("\n");
    const content = [
      `来自 ${parentBot.name} 的交接任务。上游任务：${parentRunId}`,
      `任务：${input.task}`,
      `验收标准：${input.acceptance}`,
      sources ? `可读取的上游成果（使用 read_handoff_artifact）：\n${sources}` : "",
    ].filter(Boolean).join("\n\n");
    await client.query(
      `INSERT INTO conversations(id,owner_id,bot_id,title) VALUES ($1,$2,$3,$4)`,
      [conversationId, ownerId, target.id, `交接：${input.task.slice(0, 60)}`],
    );
    await client.query(
      `INSERT INTO runs(id,owner_id,bot_id,conversation_id,model_profile_id,status,
       expected_artifact,input_revision,budget_json,capabilities_json,parent_run_id,
       root_run_id,delegation_depth,delegation_operation_id,delegation_args_hash,
       delegation_source,handoff_task,handoff_acceptance)
       VALUES ($1,$2,$3,$4,$5,'queued',$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [runId, ownerId, target.id, conversationId, target.model_profile_id,
        input.deliverable === "report", JSON.stringify(budget),
        JSON.stringify(target.capabilities_json), parentRunId, rootId,
        parent.delegation_depth + 1, operationId, argsHash, source, input.task, input.acceptance],
    );
    await snapshotBoundSkills(client, runId, target.id);
    for (const artifactId of input.artifactIds) {
      await client.query(
        "INSERT INTO run_handoff_artifacts(child_run_id,artifact_id) VALUES ($1,$2)",
        [runId, artifactId],
      );
    }
    await client.query(
      `INSERT INTO messages(id,owner_id,conversation_id,run_id,role,content)
       VALUES ($1,$2,$3,$4,'user',$5)`, [messageId, ownerId, conversationId, runId, content],
    );
    await client.query(
      `INSERT INTO run_inputs(id,owner_id,run_id,message_id,client_request_id,sequence)
       VALUES ($1,$2,$3,$4,$5,1)`, [randomUUID(), ownerId, runId, messageId, operationId],
    );
    await addEvent(client, runId, "input_added", { messageId, sequence: 1 });
    await addEvent(client, runId, "handoff_received", { parentRunId, source });
    await addEvent(client, parentRunId, "handoff_sent", { childRunId: runId, targetBotId: target.id });
    return runId;
  });
  const run = await getRun(ownerId, childId);
  return { run, conversationId: run.conversationId, targetBotId: run.botId };
}

export async function handoffReceipt(operationId: string, argsHash: string) {
  const result = await query<{ id: string; conversation_id: string; bot_id: string;
    delegation_args_hash: string }>(
    "SELECT id,conversation_id,bot_id,delegation_args_hash FROM runs WHERE delegation_operation_id=$1",
    [operationId]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.delegation_args_hash !== argsHash) {
    throw new DomainError("交接回执参数摘要不一致", 409, "handoff_receipt_mismatch");
  }
  return { childRunId: row.id, conversationId: row.conversation_id, targetBotId: row.bot_id };
}

export async function listHandoffLinks(ownerId: string, runId: string): Promise<{
  parent: HandoffLink | null; children: HandoffLink[];
}> {
  const run = await getRun(ownerId, runId);
  const linked = await query<LinkRow>(
    `SELECT r.id,r.bot_id,b.name AS bot_name,r.conversation_id,r.status,
     COALESCE(r.handoff_task,c.title) AS handoff_task,
     r.handoff_acceptance,r.delegation_depth,r.created_at
     FROM runs r JOIN bots b ON b.id=r.bot_id JOIN conversations c ON c.id=r.conversation_id
     WHERE r.owner_id=$1 AND (r.id=$2 OR r.parent_run_id=$2 OR r.id=$3)
     ORDER BY r.created_at,r.id`, [ownerId, runId, run.parentRunId],
  );
  const ids = linked.rows.map(item => item.id);
  const refs = ids.length ? await query<{ child_run_id: string; artifact_id: string }>(
    "SELECT child_run_id,artifact_id FROM run_handoff_artifacts WHERE child_run_id=ANY($1::uuid[])",
    [ids]) : { rows: [] };
  const artifactIds = new Map<string, string[]>();
  for (const ref of refs.rows) artifactIds.set(ref.child_run_id,
    [...(artifactIds.get(ref.child_run_id) || []), ref.artifact_id]);
  const toLink = (row: LinkRow): HandoffLink => ({
    id: row.id, botId: row.bot_id, botName: row.bot_name,
    conversationId: row.conversation_id, status: row.status,
    task: row.handoff_task || "", acceptance: row.handoff_acceptance || "",
    artifactIds: artifactIds.get(row.id) || [], depth: row.delegation_depth,
    createdAt: row.created_at.toISOString(),
  });
  return { parent: linked.rows.find(item => item.id === run.parentRunId)
    ? toLink(linked.rows.find(item => item.id === run.parentRunId)!) : null,
  children: linked.rows.filter(item => item.id !== runId && item.id !== run.parentRunId).map(toLink) };
}

export async function readHandoffArtifact(ownerId: string, runId: string,
  artifactId: string, offset: number, limit: number) {
  const result = await query<{ title: string; mime_type: string; sha256: string; storage_path: string }>(
    `SELECT a.title,a.mime_type,a.sha256,a.storage_path FROM run_handoff_artifacts ref
     JOIN artifacts a ON a.id=ref.artifact_id
     JOIN runs r ON r.id=ref.child_run_id
     WHERE ref.child_run_id=$1 AND ref.artifact_id=$2 AND r.owner_id=$3 AND a.owner_id=$3`,
    [runId, artifactId, ownerId]);
  const artifact = result.rows[0];
  if (!artifact || artifact.mime_type !== "text/markdown; charset=utf-8") {
    throw new DomainError("当前任务无权读取该 Markdown 成果", 403, "handoff_artifact_denied");
  }
  const bytes = await readFile(resolveArtifactPath(artifact.storage_path));
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new DomainError("交接成果摘要不匹配", 409, "handoff_artifact_mismatch");
  }
  const chars = Array.from(bytes.toString("utf8"));
  const content = chars.slice(offset, offset + limit).join("");
  const nextOffset = offset + limit < chars.length ? offset + limit : null;
  return { artifactId, title: artifact.title, sha256: artifact.sha256,
    content, totalChars: chars.length, nextOffset };
}
