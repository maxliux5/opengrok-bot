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

async function fileExists(path) {
  try { await execFile("sudo", ["-n", "docker", "exec", "opengrok-desktop", "test", "-e", path]); return true; }
  catch { return false; }
}

await execFile("sudo", ["-n", "docker", "exec", "opengrok-desktop", "rm", "-f",
  "/workspace/approval-smoke.txt", "/workspace/approval-reject.txt"]);

async function waitStatus(runId, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const run = (await api(`/runs/${runId}`)).run;
    if (run.status === expected || ["failed", "reconciling"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error(`Run ${runId} did not reach ${expected}`);
}

await api("/login", "POST", { username: "smoke", password: testPassword });
const profile = (await api("/model-profiles")).profiles.find(item => item.provider === "openai-compatible" && item.baseUrl === "http://127.0.0.1:3850/v1");
const bot = (await api("/bots", "POST", {
  name: `Approval ${Date.now()}`, description: "", instructions: "", modelProfileId: profile.id,
  capabilities: ["public_web", "workspace", "artifact", "memory", "shell"],
})).bot;

async function submit(text) {
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  return api(`/conversations/${conversation.id}/messages`, "POST", {
    text, requestId: randomUUID(), deliverable: "answer",
  });
}

const approved = await submit("在电脑工作目录创建测试文件，等待我批准。");
const waiting = await waitStatus(approved.run.id, "waiting_approval");
const approval = (await api("/approvals")).approvals.find(item => item.runId === waiting.id);
const existedBefore = await fileExists("/workspace/approval-smoke.txt");
await api(`/approvals/${approval.id}/decision`, "POST", { decision: "approve" });
const duplicate = await api(`/approvals/${approval.id}/decision`, "POST", { decision: "approve" }, 409);
const done = await waitStatus(approved.run.id, "succeeded");
const content = (await execFile("sudo", ["-n", "docker", "exec", "opengrok-desktop", "cat",
  "/workspace/approval-smoke.txt"])).stdout.trim();

const rejected = await submit("在电脑工作目录创建测试文件，请拒绝这次命令。");
await waitStatus(rejected.run.id, "waiting_approval");
const denied = (await api("/approvals")).approvals.find(item => item.runId === rejected.run.id);
await api(`/approvals/${denied.id}/decision`, "POST", { decision: "reject" });
const deniedRun = await waitStatus(rejected.run.id, "succeeded");
const existedAfterReject = await fileExists("/workspace/approval-reject.txt");
console.log(JSON.stringify({ waiting: waiting.status, existedBefore,
  target: approval.target, done: done.status, content, duplicate: duplicate.code,
  denied: deniedRun.resultText, existedAfterReject }));
if (waiting.status !== "waiting_approval" || existedBefore || done.status !== "succeeded" ||
  content !== "approved-command" || duplicate.code !== "approval_closed" ||
  !deniedRun.resultText?.includes("未创建文件") || existedAfterReject) process.exitCode = 1;
