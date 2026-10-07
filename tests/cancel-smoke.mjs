import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const base = "http://127.0.0.1:3841/api";
let cookie = "";

async function api(path, method = "GET", body, expectedStatus = 200) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const data = await response.json();
  if (response.status !== expectedStatus) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitStatus(runId, expected) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const run = (await api(`/runs/${runId}`)).run;
    if (run.status === expected) return run;
    if (["succeeded", "failed", "canceled"].includes(run.status)) {
      throw new Error(`Run reached ${run.status} before ${expected}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not reach ${expected}`);
}

await api("/login", "POST", { username: "smoke", password: testPassword });
const profile = (await api("/model-profiles")).profiles.find(item =>
  item.provider === "openai-compatible" && item.baseUrl === "http://127.0.0.1:3850/v1");
const bot = (await api("/bots", "POST", {
  name: `Cancel ${Date.now()}`, description: "", instructions: "", modelProfileId: profile.id,
  capabilities: ["public_web", "workspace", "artifact", "memory", "shell"],
})).bot;

async function submit(text, deliverable) {
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  return api(`/conversations/${conversation.id}/messages`, "POST", {
    text, requestId: randomUUID(), deliverable,
  });
}

const model = await submit("离线研究 Example Domain 并生成报告", "report");
await waitStatus(model.run.id, "running");
const started = Date.now();
await api(`/runs/${model.run.id}/cancel`, "POST");
const modelCanceled = await waitStatus(model.run.id, "canceled");
const modelCancelMs = Date.now() - started;
const modelArtifacts = (await api(`/runs/${model.run.id}/artifacts`)).artifacts.length;

await execFile("sudo", ["-n", "docker", "exec", "opengrok-desktop", "rm", "-f", "/workspace/approval-smoke.txt"]);
const shell = await submit("在电脑工作目录创建测试文件，等待我批准。", "answer");
await waitStatus(shell.run.id, "waiting_approval");
const approval = (await api("/approvals")).approvals.find(item => item.runId === shell.run.id);
await api(`/runs/${shell.run.id}/cancel`, "POST");
const shellCanceled = await waitStatus(shell.run.id, "canceled");
const oldDecision = await api(`/approvals/${approval.id}/decision`, "POST", { decision: "approve" }, 409);
let fileExists = true;
try { await execFile("sudo", ["-n", "docker", "exec", "opengrok-desktop", "test", "-e", "/workspace/approval-smoke.txt"]); }
catch { fileExists = false; }

console.log(JSON.stringify({ model: modelCanceled.status, modelCancelMs, modelArtifacts,
  approval: shellCanceled.status, oldDecision: oldDecision.code, fileExists }));
if (modelCancelMs > 5000 || modelArtifacts !== 0 || oldDecision.code !== "approval_closed" || fileExists) process.exitCode = 1;
