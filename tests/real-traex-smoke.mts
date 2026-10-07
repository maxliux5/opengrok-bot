import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { query, pool } from "../packages/core/src/db.ts";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

const base = "http://127.0.0.1:3841/api";
const provider = process.env.OPENGROK_TEST_PROVIDER === "anthropic"
  ? "anthropic" : "openai-compatible";
const modelId = process.env.OPENGROK_TEST_MODEL_ID ||
  (provider === "anthropic" ? "agy/claude-sonnet-4-6" : "traex/Gemini-3-Flash-Preview");
const proxy = loadTestProxyConfig();
const apiKey = proxy.apiKey;
let cookie = "";
let profileId: string | null = null;
let runId: string | null = null;

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitRun(id: string, initial: any) {
  let run = initial;
  const deadline = Date.now() + 180_000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    run = (await api(`/runs/${id}`)).run;
    if (run.status !== lastStatus) {
      console.log(JSON.stringify({ runId: id, status: run.status }));
      lastStatus = run.status;
    }
    if (["succeeded", "failed", "canceled"].includes(run.status)) return run;
    if (run.status === "waiting_approval") {
      const approvals = (await api("/approvals")).approvals.filter(
        (item: { runId: string }) => item.runId === id,
      );
      for (const item of approvals) {
        const allowed = item.toolName === "browser_click" &&
          item.target.includes("https://iana.org/help/example-domains");
        await api(`/approvals/${item.id}/decision`, "POST", {
          decision: allowed ? "approve" : "reject",
        });
        console.log(JSON.stringify({ runId: id, approval: item.target,
          decision: allowed ? "approve" : "reject" }));
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await api(`/runs/${id}/cancel`, "POST");
  throw new Error(`Run timed out in ${run.status}`);
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: `TraeX ${provider} test ${Date.now()}`, provider, modelId,
    baseUrl: proxy.baseUrl, apiKey,
    capabilities: { text: true, tools: true, vision: false, streaming: provider !== "anthropic" },
  })).profile;
  profileId = profile.id;
  const bot = (await api("/bots", "POST", {
    name: `Real ${provider} ${Date.now()}`, description: "", instructions: "", modelProfileId: profileId,
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "请用共享电脑打开 https://example.com/ 并读取实际页面。生成至少 100 字的中文 Markdown 报告，包含结论、依据和来源，来源链接写 https://example.com/。请依次使用 browser_open、browser_read、publish_report，不要使用 shell_exec。",
    requestId: randomUUID(), deliverable: "report",
  });
  runId = submitted.run.id;
  const run = await waitRun(runId, submitted.run);
  const artifacts = (await api(`/runs/${runId}/artifacts`)).artifacts;
  const content = artifacts[0] ? await fetch(`${base}/artifacts/${artifacts[0].id}/content`, {
    headers: { cookie }, signal: AbortSignal.timeout(15_000),
  }).then(response => response.text()) : "";
  const calls = await query<{ name: string; status: string; result: unknown }>(
    "SELECT name,status,result FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal", [runId],
  );
  const steps = await query<{ count: string; tokens: string }>(
    "SELECT count(*)::text AS count,coalesce(sum((usage_json->>'totalTokens')::int),0)::text AS tokens FROM model_steps WHERE run_id=$1 AND status='completed'",
    [runId],
  );
  console.log(JSON.stringify({ runId, provider, modelId, status: run.status, error: run.error,
    resultText: run.resultText, artifacts: artifacts.length,
    sourcePresent: content.includes("https://example.com/"),
    reportLength: content.length, steps: Number(steps.rows[0].count), tokens: Number(steps.rows[0].tokens),
    calls: calls.rows.map(call => ({ name: call.name, status: call.status })) }));
  if (run.status !== "succeeded" || artifacts.length !== 1 ||
    !content.includes("https://example.com/") || content.length < 100 ||
    !["browser_open", "browser_read", "publish_report"].every(name =>
      calls.rows.some(call => call.name === name && call.status === "succeeded"))) process.exitCode = 1;

  const memoryConversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const memorySubmitted = await api(`/conversations/${memoryConversation.id}/messages`, "POST", {
    text: "请记住我的长期报告格式偏好：以后研究报告使用中文，依次列出结论、依据、来源三个标题。请保存这条偏好到记忆库。",
    requestId: randomUUID(), deliverable: "answer",
  });
  const memoryRun = await waitRun(memorySubmitted.run.id, memorySubmitted.run);
  const memories = (await api(`/bots/${bot.id}/memories`)).memories;
  const saved = memories.find((item: { content: string }) => item.content.includes("结论") && item.content.includes("来源"));

  const recallConversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const recallSubmitted = await api(`/conversations/${recallConversation.id}/messages`, "POST", {
    text: "请按我保存的报告偏好研究 https://example.com/，只使用这个页面作为来源，不打开 Learn more 或其他网站。实际读取页面后交付一份至少 100 字、带来源链接的 Markdown 报告。",
    requestId: randomUUID(), deliverable: "report",
  });
  const recallRun = await waitRun(recallSubmitted.run.id, recallSubmitted.run);
  const recallArtifacts = (await api(`/runs/${recallSubmitted.run.id}/artifacts`)).artifacts;
  const recallContent = recallArtifacts[0] ? await fetch(`${base}/artifacts/${recallArtifacts[0].id}/content`, {
    headers: { cookie }, signal: AbortSignal.timeout(15_000),
  }).then(response => response.text()) : "";
  const headings = ["结论", "依据", "来源"].map(name =>
    new RegExp(`(^|\\n)#{1,3}\\s*(?:\\d+[.)]\\s*)?${name}(?:\\s|$)`, "m").test(recallContent));
  console.log(JSON.stringify({ provider, memoryRun: memoryRun.status, memorySaved: Boolean(saved),
    sourceMessage: Boolean(saved?.sourceMessageId), recallRun: recallRun.status,
    recallError: recallRun.error, recallTokens: recallRun.tokenCount,
    recallArtifacts: recallArtifacts.length, headings, recallSource: recallContent.includes("https://example.com/") }));
  if (memoryRun.status !== "succeeded" || !saved?.sourceMessageId ||
    recallRun.status !== "succeeded" || recallArtifacts.length !== 1 ||
    !headings.every(Boolean) || !recallContent.includes("https://example.com/")) process.exitCode = 1;
} finally {
  if (profileId) await query("UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=$1", [profileId]);
  await pool.end();
}
