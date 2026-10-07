import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pool, query } from "../packages/core/src/db.ts";

const base = process.env.OPENGROK_RESTORE_API_URL || "http://127.0.0.1:3845/api";
const password = process.env.OPENGROK_RESTORE_PASSWORD;
assert.ok(password && password.length >= 12, "需要 OPENGROK_RESTORE_PASSWORD");
assert.equal(base, "http://127.0.0.1:3845/api", "只允许隔离 API 3845");
let cookie = "";

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

try {
  const db = await query<{ name: string }>("SELECT current_database() AS name");
  assert.match(db.rows[0].name, /^opengrok_restore_[a-z0-9_]+$/);
  const bootstrap = await api("/bootstrap");
  await api(bootstrap.initialized ? "/login" : "/setup", "POST", {
    username: "restore-smoke", password,
  });
  const token = cookie.split("=", 2)[1];
  assert.ok(token);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = await query("SELECT 1 FROM sessions WHERE token_hash=$1", [tokenHash]);
  assert.equal(session.rowCount, 1, "API 未连接同一个恢复数据库");
  const historicalId = process.env.OPENGROK_EXPECT_ARTIFACT_ID;
  const historicalSha256 = process.env.OPENGROK_EXPECT_ARTIFACT_SHA256;
  if (historicalId || historicalSha256) {
    assert.ok(historicalId && historicalSha256, "历史成果 ID 和摘要必须一起提供");
    const item = (await api(`/artifacts/${historicalId}`)).artifact;
    const response = await fetch(`${base}/artifacts/${historicalId}/content`, {
      headers: { cookie }, signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, item.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), historicalSha256);
    assert.equal(item.sha256, historicalSha256);
  }
  const profile = (await api("/model-profiles", "POST", {
    name: `Restore smoke ${Date.now()}`, provider: "openai-compatible",
    modelId: "restore-test", baseUrl: "http://127.0.0.1:3850/v1",
    capabilities: { text: true, tools: false, vision: false, streaming: false },
  })).profile;
  const bot = (await api("/bots", "POST", {
    name: `恢复验证 ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id,
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "无用量恢复验证，请直接回答。", requestId: randomUUID(), deliverable: "answer",
  });
  let run = submitted.run;
  for (let attempt = 0; attempt < 60; attempt++) {
    run = (await api(`/runs/${run.id}`)).run;
    if (["succeeded", "failed", "canceled"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(run.status, "succeeded", `恢复实例新任务未成功：${run.error || run.status}`);
  assert.match(run.resultText || "", /无用量测试完成/);
  const history = (await api(`/conversations/${conversation.id}/runs`)).runs;
  assert.ok(history.some((item: { id: string }) => item.id === run.id));
  console.log(JSON.stringify({ database: db.rows[0].name, runId: run.id,
    status: run.status, resultText: run.resultText, historyVisible: true,
    historicalArtifactVerified: Boolean(historicalId) }));
} finally {
  await pool.end();
}
