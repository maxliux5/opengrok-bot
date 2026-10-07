import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const base = "http://127.0.0.1:3841/api";
const target = "/workspace/approval-smoke.txt";
let cookie = "";

async function api(path, method = "GET", body, expectedStatus = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const data = await response.json();
  if (response.status !== expectedStatus) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitFor(read, accept, label) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function fileExists() {
  try {
    await execFile("sudo", ["-n", "docker", "exec", "opengrok-desktop", "test", "-e", target]);
    return true;
  } catch { return false; }
}

await api("/login", "POST", { username: "smoke", password: testPassword });
const profile = (await api("/model-profiles")).profiles.find(item =>
  item.provider === "openai-compatible" && item.baseUrl === "http://127.0.0.1:3850/v1");
const bot = (await api("/bots", "POST", {
  name: `Approval context ${Date.now()}`, description: "", instructions: "", modelProfileId: profile.id,
  capabilities: ["public_web", "workspace", "artifact", "memory", "shell"],
})).bot;

async function pendingApproval() {
  await execFile("sudo", ["-n", "docker", "exec", "opengrok-desktop", "rm", "-f", target]);
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "在电脑工作目录创建测试文件，等待我批准。", requestId: randomUUID(), deliverable: "answer",
  });
  await waitFor(async () => (await api(`/runs/${submitted.run.id}`)).run,
    run => run.status === "waiting_approval", "approval request");
  const approval = (await api("/approvals")).approvals.find(item => item.runId === submitted.run.id);
  if (!approval) throw new Error("Approval not found");
  return { runId: submitted.run.id, approvalId: approval.id };
}

const handoff = await pendingApproval();
const control = await api("/computer/control", "POST");
try {
  const rejected = await api(`/approvals/${handoff.approvalId}/decision`, "POST", { decision: "approve" }, 409);
  const run = (await api(`/runs/${handoff.runId}`)).run;
  if (rejected.code !== "approval_closed" || run.status === "waiting_approval" || await fileExists()) {
    throw new Error(`Handoff failed to invalidate approval: ${JSON.stringify({ rejected, status: run.status })}`);
  }
} finally {
  await api(`/computer/control/${control.controlId}`, "DELETE");
}

const restart = await pendingApproval();
const before = (await api("/computer")).computer.generation;
await execFile("sudo", ["-n", "docker", "restart", "opengrok-desktop"]);
const after = await waitFor(async () => (await api("/computer")).computer,
  computer => computer.status === "ready" && computer.generation > before, "new desktop generation");
const expired = await api(`/approvals/${restart.approvalId}/decision`, "POST", { decision: "approve" }, 409);
const absent = !await fileExists();
console.log(JSON.stringify({ handoffInvalidated: true, generationBefore: before,
  generationAfter: after.generation, staleApproval: expired.code, fileAbsent: absent }));
if (expired.code !== "approval_expired" || !absent) process.exitCode = 1;
