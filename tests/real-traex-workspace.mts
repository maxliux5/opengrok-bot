import { createHash, randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { query, pool } from "../packages/core/src/db.ts";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

const base = "http://127.0.0.1:3841/api";
const modelId = "traex/Gemini-3-Flash-Preview";
const path = `runs/${randomUUID()}/gemini-check.txt`;
const expectedContent = "OpenGrok Gemini workspace check\n";
const proxy = loadTestProxyConfig();
const apiKey = proxy.apiKey;
let cookie = "";
let profileId: string | null = null;

async function api(url: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${url}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${url}: ${JSON.stringify(data)}`);
  return data;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: `TraeX workspace ${Date.now()}`, provider: "openai-compatible", modelId,
    baseUrl: proxy.baseUrl, apiKey,
  })).profile;
  profileId = profile.id;
  const bot = (await api("/bots", "POST", { name: `Gemini workspace ${Date.now()}`,
    description: "", instructions: "", modelProfileId: profileId })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: `请在共享电脑用 workspace_write 创建 ${path}，内容必须精确为 ${JSON.stringify(expectedContent)}。随后用 workspace_read 回读确认。再用 browser_open 打开 https://example.com/，用 browser_screenshot 生成截图成果。最后简短报告实际完成的操作；不要使用 shell_exec。`,
    requestId: randomUUID(), deliverable: "answer",
  });
  let run;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    run = (await api(`/runs/${submitted.run.id}`)).run;
    if (["succeeded", "failed", "canceled"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!run || !["succeeded", "failed", "canceled"].includes(run.status)) {
    await api(`/runs/${submitted.run.id}/cancel`, "POST");
    throw new Error(`Gemini Run timed out in ${run?.status}`);
  }
  const calls = await query<{ name: string; status: string; result: Record<string, unknown> }>(
    "SELECT name,status,result FROM tool_calls WHERE run_id=$1 ORDER BY created_at,ordinal",
    [submitted.run.id],
  );
  const artifacts = (await api(`/runs/${submitted.run.id}/artifacts`)).artifacts;
  const image = artifacts.find((item: { mimeType: string }) => item.mimeType === "image/png");
  const response = image && await fetch(`${base}/artifacts/${image.id}/content`, { headers: { cookie } });
  const bytes = response ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  const read = calls.rows.find(call => call.name === "workspace_read" && call.status === "succeeded");
  const required = ["workspace_write", "workspace_read", "browser_open", "browser_screenshot"];
  console.log(JSON.stringify({ runId: run.id, modelId, status: run.status, error: run.error,
    calls: calls.rows.map(call => ({ name: call.name, status: call.status })),
    fileReadMatches: read?.result.content === expectedContent,
    imageCount: artifacts.filter((item: { mimeType: string }) => item.mimeType === "image/png").length,
    imageDigestMatches: Boolean(image && createHash("sha256").update(bytes).digest("hex") === image.sha256),
    resultText: run.resultText }));
  if (run.status !== "succeeded" || read?.result.content !== expectedContent || !image ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    createHash("sha256").update(bytes).digest("hex") !== image.sha256 ||
    !required.every(name => calls.rows.some(call => call.name === name && call.status === "succeeded"))) {
    process.exitCode = 1;
  }
} finally {
  if (profileId) await query("UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=$1", [profileId]);
  await pool.end();
}
