import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";

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

await api("/login", "POST", { username: "smoke", password: testPassword });
const profile = (await api("/model-profiles")).profiles.find(item => item.provider === "openai-compatible" && item.baseUrl === "http://127.0.0.1:3850/v1");
const first = (await api("/bots", "POST", {
  name: `Memory A ${Date.now()}`, description: "测试独立记忆", instructions: "", modelProfileId: profile.id,
})).bot;
const second = (await api("/bots", "POST", {
  name: `Memory B ${Date.now()}`, description: "测试独立记忆", instructions: "", modelProfileId: profile.id,
})).bot;

async function run(bot, text) {
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text, requestId: randomUUID(), deliverable: "answer",
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    const current = (await api(`/runs/${submitted.run.id}`)).run;
    if (["succeeded", "failed", "reconciling"].includes(current.status)) return current;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error("Memory run timed out");
}

const saved = await run(first, "请记住：报告使用中文，并包含结论、依据和来源三个标题。");
const memory = (await api(`/bots/${first.id}/memories`)).memories[0];
const recalled = await run(first, "按照已有偏好输出一句话。");
const isolated = await run(second, "按照已有偏好输出一句话。");
const restricted = (await api(`/bots/${first.id}`, "PATCH", {
  capabilities: first.capabilities.filter(capability => capability !== "memory"),
  expectedRevision: first.revision,
})).bot;
const disabled = await run(first, "按照已有偏好输出一句话。");
await api(`/bots/${first.id}`, "PATCH", {
  capabilities: first.capabilities, expectedRevision: restricted.revision,
});
const updated = (await api(`/bots/${first.id}/memories/${memory.id}`, "PATCH", {
  kind: "preference", content: "报告使用中文和来源链接", expectedRevision: memory.revision,
})).memory;
const conflict = await api(`/bots/${first.id}/memories/${memory.id}`, "PATCH", {
  kind: "preference", content: "过期修改", expectedRevision: memory.revision,
}, 409);
await api(`/bots/${first.id}/memories/${memory.id}`, "DELETE", {
  expectedRevision: updated.revision,
});
const afterDelete = (await api(`/bots/${first.id}/memories`)).memories;
console.log(JSON.stringify({ saved: saved.status, memorySource: Boolean(memory.sourceMessageId),
  recalled: recalled.resultText, isolated: isolated.resultText, disabled: disabled.resultText,
  conflict: conflict.code,
  afterDelete: afterDelete.length }));
if (saved.status !== "succeeded" || !memory.sourceMessageId ||
  !recalled.resultText?.includes("已沿用偏好") || !isolated.resultText?.includes("未找到") ||
  !disabled.resultText?.includes("未找到") ||
  conflict.code !== "revision_conflict" || afterDelete.length) process.exitCode = 1;
