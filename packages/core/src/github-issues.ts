import { createHash } from "node:crypto";
import { z } from "zod";
import { query, transaction } from "./db.js";
import { DomainError } from "./errors.js";
import { toolInputSchemas } from "./model.js";
import type { ToolCallRecord } from "./tool-state.js";

const issueResponse = z.object({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullable(),
  state: z.enum(["open", "closed"]), html_url: z.url(),
  pull_request: z.unknown().optional(),
});
type IssueResponse = z.infer<typeof issueResponse>;
type IssueResult = {
  repository: string; number: number; url: string; title: string;
  bodySha256: string; state: "open" | "closed";
};
type OperationRow = {
  operation_id: string; repository: string; args_hash: string; title: string;
  body_sha256: string; status: "dispatching" | "unknown" | "succeeded" | "failed";
  result_json: IssueResult | null; error: string | null;
};
type Config = { owner: string; repo: string; repository: string; token: string; baseUrl: URL };

class GitHubRequestError extends Error {
  constructor(message: string, readonly definiteFailure: boolean) { super(message); }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function marker(operationId: string): string {
  return `<!-- opengrok-operation:${operationId} -->`;
}

function configuration(): Config {
  const repository = process.env.OPENGROK_GITHUB_REPOSITORY || "";
  const token = process.env.OPENGROK_GITHUB_TOKEN || "";
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})$/.exec(repository);
  if (!match || !token) {
    throw new DomainError("GitHub Issues 连接器未配置仓库与访问令牌", 422, "github_not_configured");
  }
  let baseUrl = new URL("https://api.github.com/");
  if (process.env.OPENGROK_TEST_MODE === "1" && process.env.OPENGROK_TEST_GITHUB_BASE_URL) {
    const candidate = new URL(process.env.OPENGROK_TEST_GITHUB_BASE_URL);
    if (candidate.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(candidate.hostname)) {
      throw new DomainError("测试 GitHub API 地址必须是本机 HTTP", 422, "invalid_test_github_url");
    }
    baseUrl = candidate;
  }
  return { owner: match[1], repo: match[2], repository, token, baseUrl };
}

export function githubIssueApprovalTarget(args: unknown): string {
  const input = toolInputSchemas.github_issue_create.parse(args);
  return `GitHub Issue：${configuration().repository}\n标题：${input.title}`;
}

export function githubIssueConnectorStatus(): { configured: boolean; repository: string | null } {
  try { return { configured: true, repository: configuration().repository }; }
  catch { return { configured: false, repository: null }; }
}

async function requestJson(config: Config, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, config.baseUrl), {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${config.token}`,
        "content-type": "application/json", "user-agent": "opengrok-bot",
        "x-github-api-version": "2026-03-10" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new GitHubRequestError("GitHub 请求结果未知", false);
  }
  if (!response.ok) {
    const definite = method === "POST" && response.status >= 400 && response.status < 500 &&
      ![408, 409, 425, 429].includes(response.status);
    throw new GitHubRequestError(`GitHub API 返回 HTTP ${response.status}`, definite);
  }
  try { return await response.json(); }
  catch { throw new GitHubRequestError("GitHub API 响应无法解析", false); }
}

function issuePath(config: Config): string {
  return `repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues`;
}

function checkedResult(config: Config, raw: unknown, operationId: string,
  title: string, body: string): IssueResult {
  const issue = issueResponse.parse(raw);
  if (issue.pull_request !== undefined || issue.title !== title ||
    issue.body !== `${body}\n\n${marker(operationId)}`) {
    throw new GitHubRequestError("GitHub Issue 回读内容与批准草稿不一致", false);
  }
  const url = new URL(issue.html_url);
  if (url.protocol !== "https:" || url.hostname !== "github.com" ||
    url.pathname.toLowerCase() !== `/${config.repository}/issues/${issue.number}`.toLowerCase()) {
    throw new GitHubRequestError("GitHub Issue 回读地址不匹配", false);
  }
  return { repository: config.repository, number: issue.number,
    url: `https://github.com/${config.repository}/issues/${issue.number}`,
    title, bodySha256: digest(body), state: issue.state };
}

async function saveOutcome(operationId: string, status: "unknown" | "succeeded" | "failed",
  result: IssueResult | null, error: string | null) {
  await query(
    `UPDATE github_issue_operations SET status=$2,result_json=$3,error=$4,updated_at=now()
     WHERE operation_id=$1`, [operationId, status, result ? JSON.stringify(result) : null, error],
  );
}

async function operation(operationId: string): Promise<OperationRow | null> {
  const result = await query<OperationRow>(
    "SELECT * FROM github_issue_operations WHERE operation_id=$1", [operationId],
  );
  return result.rows[0] || null;
}

async function findCreatedIssue(config: Config, row: OperationRow, body: string): Promise<IssueResult | null> {
  for (let page = 1; page <= 10; page++) {
    const items = z.array(issueResponse).parse(await requestJson(config, "GET",
      `${issuePath(config)}?state=all&sort=created&direction=desc&per_page=100&page=${page}`));
    const found = items.find(item => !item.pull_request && item.body?.includes(marker(row.operation_id)));
    if (found) {
      const details = await requestJson(config, "GET", `${issuePath(config)}/${found.number}`);
      return checkedResult(config, details, row.operation_id, row.title, body);
    }
    if (items.length < 100) return null;
  }
  return null;
}

export async function githubIssueReceipt(operationId: string, argsHash: string): Promise<
  { status: "succeeded"; result: IssueResult } | { status: "failed"; error: string } |
  { status: "unknown" }
> {
  const row = await operation(operationId);
  if (!row) return { status: "failed", error: "GitHub Issue 写入尚未开始" };
  if (row.args_hash !== argsHash) throw new DomainError("GitHub 操作摘要不匹配", 409, "args_mismatch");
  if (row.status === "succeeded" && row.result_json) return { status: "succeeded", result: row.result_json };
  if (row.status === "failed") return { status: "failed", error: row.error || "GitHub Issue 创建失败" };
  const config = configuration();
  if (config.repository !== row.repository) return { status: "unknown" };
  const call = await query<{ args: { body: string } }>(
    "SELECT args FROM tool_calls WHERE operation_id=$1", [operationId],
  );
  const body = call.rows[0]?.args.body;
  if (!body || digest(body) !== row.body_sha256) throw new DomainError("GitHub 草稿摘要不匹配", 409, "args_mismatch");
  const found = await findCreatedIssue(config, row, body);
  if (!found) return { status: "unknown" };
  await saveOutcome(operationId, "succeeded", found, null);
  return { status: "succeeded", result: found };
}

export async function createGithubIssue(call: ToolCallRecord, context: {
  runId: string; ownerId: string; workerId: string; epoch: number;
}): Promise<IssueResult> {
  const args = toolInputSchemas.github_issue_create.parse(call.args);
  const config = configuration();
  const firstDispatch = await transaction(async client => {
    const locked = await client.query<{ status: string; lease_owner: string | null;
      lease_epoch: string; owner_id: string; call_status: string; args_hash: string;
      run_capabilities: string[]; bot_capabilities: string[] }>(
      `SELECT r.status,r.lease_owner,r.lease_epoch,r.owner_id,c.status AS call_status,c.args_hash,
       r.capabilities_json AS run_capabilities,b.capabilities_json AS bot_capabilities
       FROM tool_calls c JOIN runs r ON r.id=c.run_id JOIN bots b ON b.id=r.bot_id
       WHERE c.id=$1 AND c.operation_id=$2 AND r.id=$3 FOR UPDATE OF r,c`,
      [call.id, call.operationId, context.runId],
    );
    const row = locked.rows[0];
    if (!row || row.status !== "running" || row.lease_owner !== context.workerId ||
      Number(row.lease_epoch) !== context.epoch || row.owner_id !== context.ownerId ||
      row.call_status !== "dispatching" || row.args_hash !== call.argsHash ||
      !row.run_capabilities.includes("github_issues") || !row.bot_capabilities.includes("github_issues")) {
      throw new DomainError("GitHub 写入授权已失效", 409, "github_authorization_lost");
    }
    const inserted = await client.query(
      `INSERT INTO github_issue_operations(operation_id,call_id,run_id,owner_id,repository,
       args_hash,title,body_sha256,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dispatching')
       ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id`,
      [call.operationId, call.id, context.runId, context.ownerId, config.repository,
        call.argsHash, args.title, digest(args.body)],
    );
    return Boolean(inserted.rowCount);
  });
  if (!firstDispatch) {
    const receipt = await githubIssueReceipt(call.operationId, call.argsHash);
    if (receipt.status === "succeeded") return receipt.result;
    throw new DomainError(receipt.status === "failed" ? receipt.error : "GitHub 写入结果待核对",
      409, receipt.status === "failed" ? "tool_failed" : "unknown_effect");
  }
  try {
    const created = issueResponse.parse(await requestJson(config, "POST", issuePath(config), {
      title: args.title, body: `${args.body}\n\n${marker(call.operationId)}`,
    }));
    const details = await requestJson(config, "GET", `${issuePath(config)}/${created.number}`);
    const result = checkedResult(config, details, call.operationId, args.title, args.body);
    await saveOutcome(call.operationId, "succeeded", result, null);
    return result;
  } catch (error) {
    const definite = error instanceof GitHubRequestError && error.definiteFailure;
    const message = error instanceof Error ? error.message : "GitHub 写入结果未知";
    await saveOutcome(call.operationId, definite ? "failed" : "unknown", null, message);
    throw new DomainError(message, 409, definite ? "tool_failed" : "unknown_effect");
  }
}
