import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pool, query } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3845/api";
const password = process.env.OPENGROK_RESTORE_PASSWORD;
assert.ok(password);
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
  await api("/login", "POST", { username: "restore-smoke", password });
  const token = cookie.split("=", 2)[1];
  const session = await query("SELECT 1 FROM sessions WHERE token_hash=$1",
    [createHash("sha256").update(token).digest("hex")]);
  assert.equal(session.rowCount, 1);
  const profile = (await api("/model-profiles", "POST", {
    name: `Restore report ${Date.now()}`, provider: "openai-compatible",
    modelId: "restore-report", baseUrl: "http://127.0.0.1:3856/v1",
    capabilities: { text: true, tools: true, vision: false, streaming: false },
  })).profile;
  const bot = (await api("/bots", "POST", {
    name: `恢复成果 ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id,
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "实际读取固定 Open Muse 文档并生成恢复测试报告。",
    requestId: randomUUID(), deliverable: "report",
  });
  let run = submitted.run;
  for (let attempt = 0; attempt < 150; attempt++) {
    run = (await api(`/runs/${run.id}`)).run;
    if (["succeeded", "failed", "canceled"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  assert.equal(run.status, "succeeded", `报告任务失败：${run.error || run.status}`);
  const artifacts = (await api(`/runs/${run.id}/artifacts`)).artifacts;
  assert.equal(artifacts.length, 1);
  const item = artifacts[0];
  const response = await fetch(`${base}/artifacts/${item.id}/content`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, item.size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256);
  const stored = await query<{ storage_path: string }>("SELECT storage_path FROM artifacts WHERE id=$1", [item.id]);
  assert.ok(stored.rows[0] && !stored.rows[0].storage_path.startsWith("/"));
  console.log(JSON.stringify({ database: db.rows[0].name, runId: run.id, artifactId: item.id,
    sha256: item.sha256, bytes: item.size, storedPath: stored.rows[0].storage_path }));
} finally {
  await pool.end();
}
