import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";

const base = "http://127.0.0.1:3841/api";
let cookie = "";

async function api(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
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
  name: `Run input ${Date.now()}`, description: "", instructions: "", modelProfileId: profile.id,
  capabilities: ["public_web", "workspace", "artifact", "memory", "shell"],
})).bot;

async function conversation() {
  return (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
}
async function submit(conversationId, text, deliverable) {
  return api(`/conversations/${conversationId}/messages`, "POST", {
    text, requestId: randomUUID(), deliverable,
  });
}

const firstConversation = await conversation();
const original = await submit(firstConversation.id, "离线研究 Example Domain 并生成报告", "report");
await waitStatus(original.run.id, "running");
const supplement = await submit(firstConversation.id, "补充验证标记ABC：报告仍需包含来源", "report");
const finished = await waitStatus(original.run.id, "succeeded");
const artifacts = (await api(`/runs/${original.run.id}/artifacts`)).artifacts;

const heldConversation = await conversation();
const held = await submit(heldConversation.id, "在电脑工作目录创建测试文件，等待我批准。", "answer");
await waitStatus(held.run.id, "waiting_approval");
const followingConversation = await conversation();
const following = await submit(followingConversation.id, "研究 Example Domain 并生成报告", "report");
await new Promise(resolve => setTimeout(resolve, 1200));
const beforeRelease = (await api(`/runs/${following.run.id}`)).run;
await api(`/runs/${held.run.id}/cancel`, "POST");
const afterRelease = await waitStatus(following.run.id, "succeeded");

console.log(JSON.stringify({ sameRun: original.run.id === supplement.run.id,
  inputRevision: finished.inputRevision, supplementSeen: finished.resultText?.includes("补充验证标记ABC"),
  artifactCount: artifacts.length, slotHeld: beforeRelease.status, afterRelease: afterRelease.status }));
if (original.run.id !== supplement.run.id || finished.inputRevision < 2 ||
  !finished.resultText?.includes("补充验证标记ABC") || artifacts.length !== 1 ||
  beforeRelease.status !== "queued") process.exitCode = 1;
