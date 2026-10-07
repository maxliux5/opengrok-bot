import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { query, pool } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
let cookie = "";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

type Case = { name: string; override: Record<string, number>; text: string;
  deliverable: "answer" | "report" };
const cases: Case[] = [
  { name: "tools", override: { maxToolCalls: 1 }, text: "研究 Example Domain 并交付报告", deliverable: "report" },
  { name: "tokens", override: { maxTokens: 1 }, text: "研究 Example Domain 并交付报告", deliverable: "report" },
  { name: "artifact", override: { maxArtifactBytes: 100 }, text: "研究 Example Domain 并交付报告", deliverable: "report" },
  { name: "steps", override: { maxModelSteps: 1 }, text: "研究 Example Domain 并交付报告", deliverable: "report" },
  { name: "wall", override: { maxWallMs: 1000 }, text: "离线研究 Example Domain 并交付报告", deliverable: "report" },
  { name: "model_timeout", override: { maxModelCallMs: 1000 }, text: "离线研究 Example Domain 并交付报告", deliverable: "report" },
  { name: "estimated", override: {}, text: "无用量：只需简短回答", deliverable: "answer" },
];

let worker: ReturnType<typeof spawn> | null = null;
try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: "Budget fake model", provider: "openai-compatible", modelId: "test-model",
    baseUrl: "http://127.0.0.1:3850/v1",
  })).profile;
  const prepared: Array<{ test: Case; runId: string }> = [];
  for (const test of cases) {
    const bot = (await api("/bots", "POST", { name: `Budget ${test.name} ${Date.now()}`,
      description: "", instructions: "", modelProfileId: profile.id })).bot;
    const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
    const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
      text: test.text, requestId: randomUUID(), deliverable: test.deliverable,
    });
    const budget = { ...submitted.run.budget, ...test.override };
    await query("UPDATE runs SET budget_json=$2 WHERE id=$1 AND status='queued'",
      [submitted.run.id, JSON.stringify(budget)]);
    prepared.push({ test, runId: submitted.run.id });
  }
  worker = spawn("pnpm", ["dev:worker"], {
    cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let workerOutput = "";
  worker.stdout?.on("data", chunk => { workerOutput += String(chunk).slice(-1000); });
  worker.stderr?.on("data", chunk => { workerOutput += String(chunk).slice(-1000); });
  const deadline = Date.now() + 90_000;
  const results = [];
  for (const item of prepared) {
    let run;
    while (Date.now() < deadline) {
      run = (await api(`/runs/${item.runId}`)).run;
      if (["succeeded", "failed", "canceled"].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!run || !["succeeded", "failed", "canceled"].includes(run.status)) {
      throw new Error(`Budget case ${item.test.name} timed out: ${workerOutput.slice(-1500)}`);
    }
    const calls = await query<{ name: string; status: string }>(
      "SELECT name,status FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal", [item.runId],
    );
    const artifacts = (await api(`/runs/${item.runId}/artifacts`)).artifacts;
    results.push({ name: item.test.name, runId: item.runId, status: run.status,
      error: run.error, tokenCount: run.tokenCount, tokenUsageEstimated: run.tokenUsageEstimated,
      toolCount: run.toolCount, budget: run.budget, calls: calls.rows, artifacts: artifacts.length });
  }
  console.log(JSON.stringify(results));
  const byName = Object.fromEntries(results.map(item => [item.name, item]));
  if (byName.tools.status !== "failed" || byName.tools.toolCount !== 1 ||
    !byName.tools.error?.includes("工具次数预算") ||
    !byName.tools.calls.some(call => call.name === "browser_read" && call.status === "failed") ||
    byName.tokens.status !== "failed" || byName.tokens.toolCount !== 0 ||
    !byName.tokens.error?.includes("token 预算") ||
    !byName.tokens.calls.some(call => call.name === "browser_open" && call.status === "failed") ||
    byName.artifact.status !== "failed" || byName.artifact.artifacts !== 0 ||
    !byName.artifact.calls.some(call => call.name === "publish_report" && call.status === "failed") ||
    byName.steps.status !== "failed" || !byName.steps.error?.includes("模型步骤上限") ||
    byName.wall.status !== "failed" || !byName.wall.error?.includes("总时长预算") ||
    byName.model_timeout.status !== "failed" || !byName.model_timeout.error?.includes("模型调用超过时限") ||
    byName.estimated.status !== "succeeded" || !byName.estimated.tokenUsageEstimated ||
    byName.estimated.tokenCount <= 0) process.exitCode = 1;
} finally {
  if (worker?.pid) {
    try { process.kill(-worker.pid, "SIGINT"); }
    catch { /* worker may have exited */ }
    await Promise.race([once(worker, "exit"), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  await pool.end();
}
