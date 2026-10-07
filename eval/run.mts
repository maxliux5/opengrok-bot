import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pool, query } from "../packages/core/src/db.ts";
import { evalCases, fixtureCommit, type EvalCase, type EvalStep } from "./cases.v1.mts";
import { loadTestProxyConfig } from "../tests/test-proxy-config.mts";

const args = process.argv.slice(2);
let chosenId: string | undefined;
let requestedRepeats: number | undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--list") continue;
  if (arg === "--case") {
    chosenId = args[++index];
    if (!chosenId || chosenId.startsWith("--")) throw new Error("--case 需要任务 ID");
  } else if (arg === "--repeats") {
    requestedRepeats = Number(args[++index]);
  } else {
    throw new Error(`未知参数：${arg}`);
  }
}
const repeats = requestedRepeats ?? (chosenId ? 1 : 3);
const ids = new Set(evalCases.map(item => item.id));
assert.equal(ids.size, 12, "评测集必须恰好包含 12 个不同任务");
assert.ok(evalCases.every(item => item.steps.length > 0));
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 3, "--repeats 必须是 1 至 3");
if (args.includes("--list")) {
  for (const item of evalCases) console.log(`${item.id}\t${item.category}\t${item.steps.length} step(s)`);
  process.exit(0);
}
if (chosenId && !ids.has(chosenId)) throw new Error(`未知评测任务：${chosenId}`);

const selected = chosenId ? evalCases.filter(item => item.id === chosenId) : evalCases;
const base = process.env.OPENGROK_EVAL_API_URL || "http://127.0.0.1:3841/api";
assert.equal(base, "http://127.0.0.1:3841/api", "评测仅允许连接本机隔离 API 3841");
const databaseName = process.env.OPENGROK_EVAL_DB_NAME || "opengrok_test";
assert.ok(databaseName === "opengrok_test" || /^opengrok_eval_\d{8}(?:_[a-z])?$/.test(databaseName),
  "评测数据库必须是 opengrok_test 或带日期的 opengrok_eval_ 隔离库");
const runtimeUrl = process.env.OPENGROK_EVAL_RUNTIME_URL || "http://127.0.0.1:3843";
assert.ok(["http://127.0.0.1:3843", "http://127.0.0.1:3845"].includes(runtimeUrl),
  "评测仅允许连接本机桌面 runtime 3843 或隔离 runtime 3845");
const provider = process.env.OPENGROK_EVAL_PROVIDER || "openai-compatible";
assert.ok(["anthropic", "openai-compatible"].includes(provider), "未知模型协议");
const modelId = process.env.OPENGROK_EVAL_MODEL_ID ||
  (provider === "anthropic" ? "agy/claude-sonnet-4-6" : "traex/Gemini-3-Flash-Preview");
const username = process.env.OPENGROK_EVAL_USERNAME || "smoke";
const password = process.env.OPENGROK_EVAL_PASSWORD;
if (!password) throw new Error("缺少 OPENGROK_EVAL_PASSWORD");
const output = process.env.OPENGROK_EVAL_RESULTS || ".local/eval/results-v1.jsonl";
const manifestHash = createHash("sha256").update(await readFile(new URL("./cases.v1.mts", import.meta.url))).digest("hex");
const runnerHash = createHash("sha256").update(await readFile(new URL("./run.mts", import.meta.url))).digest("hex");
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist", "coverage", ".local"].includes(entry.name)) {
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && !entry.name.endsWith(".tsbuildinfo")) {
      files.push(path);
    }
  }
  return files;
}
const sourcePaths = (await Promise.all(["apps", "packages", "infra"].map(sourceFiles)))
  .flat().concat(["package.json", "pnpm-lock.yaml", "tsconfig.base.json"]).sort();
const appHashBuilder = createHash("sha256");
for (const path of sourcePaths) {
  appHashBuilder.update(path).update("\0").update(await readFile(path)).update("\0");
}
const appHash = appHashBuilder.digest("hex");
const variant = process.env.OPENGROK_EVAL_VARIANT || "baseline";
let cookie = "";
let profileId: string | null = null;
let runtimeToken: string | null = null;
const submittedRuns: string[] = [];
const sessionId = randomUUID();

type ApiRun = { id: string; status: string; resultText: string | null; error: string | null;
  tokenCount: number; tokenUsageEstimated: boolean; toolCount: number;
  createdAt: string; updatedAt: string };
type ToolCall = { name: string; status: string; args: Record<string, unknown> | null;
  result: Record<string, unknown> | null };
type Artifact = { id: string; mimeType: string; sha256: string; size: number; sources: string[] };

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function record(event: Record<string, unknown>) {
  await appendFile(output, `${JSON.stringify({ at: new Date().toISOString(), sessionId,
    fixtureCommit, manifestHash, runnerHash, appHash, variant, provider, modelId, ...event })}\n`,
  { encoding: "utf8", flag: "a" });
}

function fill(value: string, vars: Record<string, string>) {
  return value.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const replacement = vars[key];
    if (replacement === undefined) throw new Error(`未知评测变量 ${key}`);
    return replacement;
  });
}

function headingPresent(markdown: string, heading: string) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)#{1,3}\\s*(?:\\d+[.)]\\s*)?${escaped}(?:\\s|$)`, "m")
    .test(markdown);
}

function sourceMatch(actual: string, required: string) {
  try { return new URL(actual).href === new URL(required).href; }
  catch { return false; }
}

async function runtimeRead(path: string) {
  if (!runtimeToken) {
    const line = (await readFile(".local/desktop.env", "utf8")).split("\n")
      .find(item => item.startsWith("OPENGROK_RUNTIME_TOKEN="));
    if (!line) throw new Error("缺少本地桌面 runtime token");
    runtimeToken = line.slice(line.indexOf("=") + 1).trim();
  }
  const response = await fetch(`${runtimeUrl}/operation`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "workspace_read", args: { path }, operationId: randomUUID(),
      controlEpoch: 1, deadline: Date.now() + 15_000 }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`工作文件回读失败 ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data as { content: string; sha256: string };
}

async function waitRun(id: string) {
  const deadline = Date.now() + 300_000;
  let unexpectedApprovals = 0;
  let run: ApiRun = (await api(`/runs/${id}`)).run;
  while (Date.now() < deadline) {
    if (["succeeded", "failed", "canceled", "reconciling"].includes(run.status)) {
      return { run, unexpectedApprovals, timedOut: false };
    }
    if (run.status === "waiting_approval") {
      const pending = (await api("/approvals")).approvals as Array<{ id: string; runId: string }>;
      for (const approval of pending.filter(item => item.runId === id)) {
        await api(`/approvals/${approval.id}/decision`, "POST", { decision: "reject" });
        unexpectedApprovals++;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 800));
    run = (await api(`/runs/${id}`)).run;
  }
  await api(`/runs/${id}/cancel`, "POST").catch(() => undefined);
  return { run, unexpectedApprovals, timedOut: true };
}

async function verifyStep(step: EvalStep, vars: Record<string, string>, run: ApiRun) {
  const failures: string[] = [];
  if (run.status !== "succeeded") failures.push(`run:${run.status}:${run.error || ""}`);
  const calls = (await query<ToolCall>(
    "SELECT name,status,args,result FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal",
    [run.id],
  )).rows;
  const forbidden = calls.filter(call => ["shell_exec", "desktop_click", "desktop_key",
    "desktop_type", "browser_click", "browser_fill"].includes(call.name));
  if (forbidden.length) failures.push(`unexpected_tools:${forbidden.map(call => call.name).join(",")}`);
  for (const [name, minimum] of Object.entries(step.toolMinimums || {})) {
    const succeeded = calls.filter(call => call.name === name && call.status === "succeeded").length;
    if (succeeded < minimum) failures.push(`tool:${name}:${succeeded}/${minimum}`);
  }
  for (const expected of step.answerIncludes || []) {
    if (!run.resultText?.includes(fill(expected, vars))) failures.push(`answer_missing:${expected}`);
  }
  if (step.memoryIncludes?.length) {
    const memories = (await api(`/bots/${vars.botId}/memories`)).memories as
      Array<{ content: string; sourceMessageId: string | null }>;
    for (const expected of step.memoryIncludes) {
      if (!memories.some(memory => memory.sourceMessageId &&
        memory.content.includes(fill(expected, vars)))) failures.push(`memory_missing:${expected}`);
    }
  }
  for (const file of step.files || []) {
    const path = fill(file.path, vars);
    try {
      const read = await runtimeRead(path);
      if (read.sha256 !== createHash("sha256").update(read.content).digest("hex")) {
        failures.push(`file_digest:${path}`);
      }
      if (file.equals !== undefined && read.content !== fill(file.equals, vars)) {
        failures.push(`file_value:${path}`);
      }
      for (const expected of file.includes || []) {
        if (!read.content.includes(fill(expected, vars))) failures.push(`file_missing:${path}:${expected}`);
      }
    } catch (error) { failures.push(`file_read:${path}:${String(error)}`); }
  }
  if (step.report) {
    const artifacts = (await api(`/runs/${run.id}/artifacts`)).artifacts as Artifact[];
    const markdown = artifacts.filter(item => item.mimeType.startsWith("text/markdown"));
    if (markdown.length !== 1) failures.push(`report_count:${markdown.length}`);
    if (markdown[0]) {
      const response = await fetch(`${base}/artifacts/${markdown[0].id}/content`, {
        headers: { cookie }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) failures.push(`report_http:${response.status}`);
      else {
        const bytes = Buffer.from(await response.arrayBuffer());
        const content = bytes.toString("utf8");
        if (bytes.length !== markdown[0].size ||
          createHash("sha256").update(bytes).digest("hex") !== markdown[0].sha256) {
          failures.push("report_digest");
        }
        if (content.length < (step.report.minChars || 100)) failures.push("report_too_short");
        for (const expected of step.report.includes || []) {
          if (!content.includes(fill(expected, vars))) failures.push(`report_missing:${expected}`);
        }
        for (const heading of step.report.headings || []) {
          if (!headingPresent(content, heading)) failures.push(`heading_missing:${heading}`);
        }
        for (const source of step.report.sources) {
          const expected = fill(source, vars);
          if (!markdown[0].sources.some(actual => sourceMatch(actual, expected)) ||
            !content.includes(expected)) failures.push(`report_source:${expected}`);
          if (!calls.some(call => call.name === "browser_read" && call.status === "succeeded" &&
            typeof call.result?.url === "string" && sourceMatch(call.result.url, expected))) {
            failures.push(`source_not_read:${expected}`);
          }
        }
      }
    }
  }
  if (step.prompt.includes("expectedSha256")) {
    const validCas = calls.some((call, index) => call.name === "workspace_write" &&
      call.status === "succeeded" && typeof call.args?.expectedSha256 === "string" &&
      calls.slice(0, index).some(prior => prior.name === "workspace_read" &&
        prior.status === "succeeded" && prior.result?.sha256 === call.args?.expectedSha256 &&
        prior.result?.path === call.args?.path));
    if (!validCas) failures.push("cas_hash_not_from_prior_read");
  }
  return { failures, calls: calls.map(call => ({ name: call.name, status: call.status })),
    artifacts: step.report ? (await api(`/runs/${run.id}/artifacts`)).artifacts.length : 0 };
}

async function attempt(item: EvalCase, ordinal: number, profile: string) {
  const attemptId = randomUUID();
  const marker = `EVAL-${randomUUID().slice(0, 12).toUpperCase()}`;
  const vars: Record<string, string> = {
    marker, secondMarker: `NEXT-${randomUUID().slice(0, 12).toUpperCase()}`,
    file: `eval-${item.id}-${attemptId.slice(0, 8)}.txt`,
    secondFile: `eval-${item.id}-${attemptId.slice(0, 8)}-second.txt`,
  };
  const started = Date.now();
  const stages: Record<string, unknown>[] = [];
  let passed = true;
  await record({ event: "attempt_started", attemptId, caseId: item.id, ordinal,
    category: item.category, reviewQuestion: item.reviewQuestion });
  try {
    const bot = (await api("/bots", "POST", { name: `Eval ${item.id} ${ordinal}`,
      description: "冻结任务集 v1", instructions: "用实际工具回执回答；遇到无法验证的结果明确说明。",
      modelProfileId: profile, capabilities: ["public_web", "workspace", "artifact", "memory"] })).bot;
    vars.botId = bot.id;
    let conversationId: string | null = null;
    for (let index = 0; index < item.steps.length; index++) {
      const step = item.steps[index];
      if (!conversationId || step.newConversation) {
        conversationId = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation.id;
      }
      const submitted = await api(`/conversations/${conversationId}/messages`, "POST", {
        text: fill(step.prompt, vars), requestId: randomUUID(), deliverable: step.deliverable,
      });
      const runId: string = submitted.run.id;
      submittedRuns.push(runId);
      await record({ event: "run_submitted", attemptId, caseId: item.id, ordinal,
        stage: index + 1, botId: bot.id, conversationId, runId });
      const { run, unexpectedApprovals, timedOut } = await waitRun(runId);
      const checks = await verifyStep(step, vars, run);
      if (unexpectedApprovals) checks.failures.push(`unexpected_approvals:${unexpectedApprovals}`);
      if (timedOut) checks.failures.push("run_timeout");
      if (checks.failures.length) passed = false;
      stages.push({ stage: index + 1, runId, conversationId, status: run.status,
        error: run.error, durationMs: Date.now() - Date.parse(run.createdAt),
        tokenCount: run.tokenCount, tokenUsageEstimated: run.tokenUsageEstimated,
        toolCount: run.toolCount, unexpectedApprovals, timedOut, ...checks });
      if (checks.failures.length) break;
    }
  } catch (error) {
    passed = false;
    stages.push({ harnessError: error instanceof Error ? error.message : String(error) });
  }
  await record({ event: "attempt_finished", attemptId, caseId: item.id, ordinal,
    category: item.category, automatedPassed: passed, manualReview: "pending",
    durationMs: Date.now() - started, stages });
  console.log(JSON.stringify({ caseId: item.id, ordinal, automatedPassed: passed,
    durationMs: Date.now() - started, stages }));
  return passed;
}

try {
  await mkdir(dirname(output), { recursive: true });
  const db = await query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(db.rows[0]?.name, databaseName, "评测进程未连接指定的隔离数据库");
  await api("/login", "POST", { username, password });
  const token = cookie.split("=", 2)[1];
  assert.ok(token, "测试 API 未建立会话");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = await query("SELECT 1 FROM sessions WHERE token_hash=$1", [tokenHash]);
  assert.equal(session.rowCount, 1, "API 没有连接同一个隔离数据库");
  const proxy = loadTestProxyConfig();
  const apiKey = proxy.apiKey;
  const profile = (await api("/model-profiles", "POST", {
    name: `Eval ${provider} ${Date.now()}`, provider, modelId,
    baseUrl: proxy.baseUrl, apiKey,
    capabilities: { text: true, tools: true, vision: false, streaming: provider !== "anthropic" },
  })).profile;
  const createdProfileId: string = profile.id;
  profileId = createdProfileId;
  await record({ event: "session_started", profileId, cases: selected.map(item => item.id), repeats });
  let failed = 0;
  for (const item of selected) {
    for (let ordinal = 1; ordinal <= repeats; ordinal++) {
      if (!await attempt(item, ordinal, createdProfileId)) failed++;
    }
  }
  await record({ event: "session_finished", attempts: selected.length * repeats, failed });
  if (failed) process.exitCode = 1;
} finally {
  for (const id of submittedRuns) {
    await api(`/runs/${id}/cancel`, "POST").catch(() => undefined);
  }
  if (profileId) await query("UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=$1", [profileId]);
  await pool.end();
}
