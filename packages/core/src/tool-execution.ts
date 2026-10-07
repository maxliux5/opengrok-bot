import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RunBudget } from "@opengrok/contracts";
import { query, transaction } from "./db.js";
import { artifactDir, dataDir } from "./config.js";
import { storedArtifactPath } from "./artifact-path.js";
import { DomainError } from "./errors.js";
import { hostRequest } from "./host-auth.js";
import { createHandoff, readHandoffArtifact } from "./handoffs.js";
import { toolInputSchemas, verifyToolResult } from "./model.js";
import { listMemories } from "./resources.js";
import { searchMemories } from "./memory-context.js";
import { createGithubIssue } from "./github-issues.js";
import { runInputMessages } from "./runs.js";
import type { ToolCallRecord } from "./tool-state.js";

export async function computerReady(): Promise<boolean> {
  return (await computerAccess()).ready;
}

export async function computerAccess(): Promise<{ ready: boolean; controlEpoch: number; generation: number }> {
  try {
    const health = await hostRequest<{ ready: boolean; controlEpoch: number; generation: number }>("/health", {}, 3000);
    return health;
  } catch {
    return { ready: false, controlEpoch: 0, generation: 0 };
  }
}

async function computerOperation(call: ToolCallRecord, runId: string, epoch: number, controlEpoch: number) {
  const result = await hostRequest<{ outcome: "succeeded" | "failed" | "unknown"; result: unknown }>(
    "/operations", {
      method: "POST",
      body: JSON.stringify({
        operationId: call.operationId, runId, epoch, controlEpoch, name: call.name,
        args: call.args, argsHash: call.argsHash,
        deadline: Date.now() + 120_000,
      }),
    },
  );
  if (result.outcome === "unknown") throw new DomainError("电脑操作结果待核对", 409, "unknown_effect");
  if (result.outcome === "failed") throw new DomainError(
    (result.result as { error?: string } | null)?.error || "电脑操作失败", 422, "tool_failed",
  );
  return result.result;
}

async function publishReport(call: ToolCallRecord, runId: string, ownerId: string,
  budget: RunBudget) {
  const args = toolInputSchemas.publish_report.parse(call.args);
  const visited = await query<{ url: string }>(
    `SELECT result->>'url' AS url FROM tool_calls WHERE run_id=$1 AND name='browser_read'
     AND status='succeeded' AND result ? 'url'`, [runId],
  );
  const visitedUrls = new Set(visited.rows.map(row => new URL(row.url).href));
  for (const source of args.sources) {
    if (!visitedUrls.has(new URL(source).href)) {
      throw new DomainError(`报告来源尚未由浏览器读取：${source}`, 422, "unread_source");
    }
    if (!args.markdown.includes(source)) {
      throw new DomainError(`报告正文缺少来源链接：${source}`, 422, "uncited_source");
    }
  }
  if (!/^#{1,6}\s+\S/m.test(args.markdown)) {
    throw new DomainError("报告缺少 Markdown 标题", 422, "invalid_report_format");
  }
  const content = Buffer.from(args.markdown, "utf8");
  if (content.length > Math.min(250_000, budget.maxArtifactBytes)) {
    throw new DomainError("报告超过成果大小预算", 422, "artifact_too_large");
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const runDir = join(artifactDir, runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const stagingDir = join(dataDir, "staging", runId);
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const path = join(runDir, `${call.operationId}.md`);
  const temporary = join(stagingDir, `${call.operationId}.${randomUUID()}.part`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, path);
    const directory = await open(runDir, "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(content)) throw new DomainError("成果操作 ID 对应了不同内容", 409, "artifact_collision");
  } finally {
    await unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  const artifact = await transaction(async client => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM artifacts WHERE run_id=$1 AND sha256=$2 LIMIT 1", [runId, sha256],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO artifacts(id,owner_id,run_id,title,mime_type,sha256,size_bytes,storage_path,source_refs)
       VALUES ($1,$2,$3,$4,'text/markdown; charset=utf-8',$5,$6,$7,$8)
       ON CONFLICT (run_id,sha256) DO NOTHING RETURNING id`,
      [id, ownerId, runId, `${args.title}.md`, sha256, content.length, storedArtifactPath(path), JSON.stringify(args.sources)],
    );
    if (inserted.rows[0]) return id;
    const winner = await client.query<{ id: string }>(
      "SELECT id FROM artifacts WHERE run_id=$1 AND sha256=$2", [runId, sha256],
    );
    return winner.rows[0].id;
  });
  return { artifactId: artifact, title: args.title, sha256, sources: args.sources };
}

export async function finalizeScreenshot(call: ToolCallRecord, runId: string, ownerId: string,
  receipt: unknown) {
  const result = receipt as { sha256?: string; sizeBytes?: number; url?: string;
    observationId?: string; width?: number; height?: number; sessionId?: string;
    generation?: number; controlEpoch?: number } | null;
  const path = join(artifactDir, runId, `${call.operationId}.png`);
  const content = await readFile(path);
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (content.length < 24 || content.length > 2_000_000 ||
    !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    result?.sha256 !== sha256 || result.sizeBytes !== content.length) {
    throw new DomainError("截图文件与电脑回执不一致", 409, "screenshot_mismatch");
  }
  const run = await query<{ budget_json: RunBudget }>(
    "SELECT budget_json FROM runs WHERE id=$1 AND owner_id=$2", [runId, ownerId],
  );
  if (!run.rows[0]) throw new DomainError("找不到任务", 404, "run_not_found");
  if (content.length > run.rows[0].budget_json.maxArtifactBytes) {
    throw new DomainError("截图超过成果大小预算", 422, "artifact_too_large");
  }
  if (call.name === "desktop_observe" && (result.width !== content.readUInt32BE(16) ||
    result.height !== content.readUInt32BE(20))) {
    throw new DomainError("桌面截图尺寸与电脑回执不一致", 409, "screenshot_mismatch");
  }
  const source = result.url && /^https?:$/.test(new URL(result.url).protocol) ? [result.url] : [];
  const artifactId = await transaction(async client => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM artifacts WHERE run_id=$1 AND sha256=$2 LIMIT 1", [runId, sha256],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO artifacts(id,owner_id,run_id,title,mime_type,sha256,size_bytes,storage_path,source_refs)
       VALUES ($1,$2,$3,$4,'image/png',$5,$6,$7,$8)
       ON CONFLICT (run_id,sha256) DO NOTHING RETURNING id`,
      [id, ownerId, runId, `${call.name === "desktop_observe" ? "桌面" : "网页"}截图-${call.operationId.slice(0, 8)}.png`, sha256,
        content.length, storedArtifactPath(path), JSON.stringify(source)],
    );
    if (inserted.rows[0]) return id;
    const winner = await client.query<{ id: string }>(
      "SELECT id FROM artifacts WHERE run_id=$1 AND sha256=$2", [runId, sha256],
    );
    return winner.rows[0].id;
  });
  return call.name === "desktop_observe"
    ? { artifactId, sha256, sizeBytes: content.length, sources: source,
      observationId: result.observationId, width: result.width, height: result.height,
      sessionId: result.sessionId, generation: result.generation,
      controlEpoch: result.controlEpoch }
    : { artifactId, sha256, sizeBytes: content.length, sources: source };
}

async function remember(call: ToolCallRecord, runId: string, ownerId: string, botId: string) {
  const args = toolInputSchemas.remember.parse(call.args);
  const inputs = await runInputMessages(runId);
  const explicit = inputs.some(input => /记住|保存.{0,12}偏好|remember|以后.{0,12}请/i.test(input.content));
  if (!explicit) throw new DomainError("用户尚未明确要求保存这条记忆", 422, "memory_not_requested");
  return transaction(async client => {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM memory_entries WHERE operation_id=$1", [call.operationId],
    );
    if (existing.rows[0]) return { memoryId: existing.rows[0].id };
    const id = randomUUID();
    const source = await client.query<{ message_id: string }>(
      "SELECT message_id FROM run_inputs WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1", [runId],
    );
    await client.query(
      `INSERT INTO memory_entries(id,owner_id,bot_id,kind,content,status,source_message_id,operation_id)
       VALUES ($1,$2,$3,$4,$5,'accepted',$6,$7)`,
      [id, ownerId, botId, args.kind, args.content, source.rows[0]?.message_id || null, call.operationId],
    );
    return { memoryId: id };
  });
}

type ToolExecutionContext = {
  runId: string; ownerId: string; botId: string; workerId: string; epoch: number; controlEpoch?: number;
  budget: RunBudget;
};

export async function executeTool(call: ToolCallRecord, context: ToolExecutionContext): Promise<unknown> {
  return verifyToolResult(call.name, call.args, await executeUnverifiedTool(call, context));
}

async function executeUnverifiedTool(call: ToolCallRecord, context: ToolExecutionContext): Promise<unknown> {
  switch (call.name) {
    case "browser_open": {
      toolInputSchemas.browser_open.parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
    case "browser_read": {
      toolInputSchemas.browser_read.parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
    case "browser_screenshot": {
      toolInputSchemas.browser_screenshot.parse(call.args);
      const receipt = await computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
      return finalizeScreenshot(call, context.runId, context.ownerId, receipt);
    }
    case "desktop_observe": {
      toolInputSchemas.desktop_observe.parse(call.args);
      const receipt = await computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
      return finalizeScreenshot(call, context.runId, context.ownerId, receipt);
    }
    case "desktop_click":
    case "desktop_key":
    case "desktop_type": {
      toolInputSchemas[call.name].parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
    case "browser_click": {
      toolInputSchemas.browser_click.parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
    case "browser_fill": {
      toolInputSchemas.browser_fill.parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
    case "workspace_list": {
      toolInputSchemas.workspace_list.parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
    case "workspace_read": {
      toolInputSchemas.workspace_read.parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
    case "workspace_write": {
      toolInputSchemas.workspace_write.parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
    case "publish_report":
      return publishReport(call, context.runId, context.ownerId, context.budget);
    case "remember":
      return remember(call, context.runId, context.ownerId, context.botId);
    case "memory_search": {
      const args = toolInputSchemas.memory_search.parse(call.args);
      const memories = await listMemories(context.ownerId, context.botId);
      const matches = searchMemories(memories, args.query);
      return { memories: matches.map(item => ({ id: item.id, kind: item.kind, content: item.content,
        revision: item.revision, sourceMessageId: item.sourceMessageId, updatedAt: item.updatedAt })) };
    }
    case "read_handoff_artifact": {
      const args = toolInputSchemas.read_handoff_artifact.parse(call.args);
      return readHandoffArtifact(context.ownerId, context.runId, args.artifactId,
        args.offset, args.limit);
    }
    case "delegate_to_bot": {
      const args = toolInputSchemas.delegate_to_bot.parse(call.args);
      const child = await createHandoff(context.ownerId, context.runId, call.operationId,
        "agent", args, { workerId: context.workerId, epoch: context.epoch,
          callId: call.id, argsHash: call.argsHash });
      return { childRunId: child.run.id, conversationId: child.conversationId,
        targetBotId: child.targetBotId };
    }
    case "github_issue_create":
      return createGithubIssue(call, context);
    case "shell_exec": {
      toolInputSchemas.shell_exec.parse(call.args);
      return computerOperation(call, context.runId, context.epoch, context.controlEpoch || 0);
    }
  }
  throw new DomainError("未注册的工具", 422, "unknown_tool");
}
