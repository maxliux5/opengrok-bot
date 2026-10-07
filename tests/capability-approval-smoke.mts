import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pool, query } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
let cookie = "";

async function api(path: string, method = "GET", body?: unknown, expectedStatus = 200) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profiles = (await api("/model-profiles")).profiles;
  const profile = profiles.find((item: { baseUrl: string }) => item.baseUrl === "http://127.0.0.1:3850/v1");
  assert.ok(profile);
  const bot = (await api("/bots", "POST", {
    name: `Capability approval ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id,
    capabilities: ["public_web", "workspace", "artifact", "memory", "shell"],
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const { run } = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "在电脑工作目录创建测试文件，等待我批准。",
    requestId: randomUUID(), deliverable: "answer",
  });
  let waiting;
  for (let attempt = 0; attempt < 50; attempt++) {
    waiting = (await api(`/runs/${run.id}`)).run;
    if (waiting.status === "waiting_approval") break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.equal(waiting?.status, "waiting_approval");
  const approval = (await api("/approvals")).approvals.find((item: { runId: string }) => item.runId === run.id);
  assert.ok(approval);
  await api(`/bots/${bot.id}`, "PATCH", {
    expectedRevision: bot.revision,
    capabilities: ["public_web", "workspace", "artifact", "memory"],
  });
  const closed = await api(`/approvals/${approval.id}/decision`, "POST", { decision: "approve" }, 409);
  const final = (await api(`/runs/${run.id}`)).run;
  const calls = await query<{ status: string; result: { error: string } }>(
    "SELECT status,result FROM tool_calls WHERE run_id=$1 AND name='shell_exec'", [run.id],
  );
  const journal = new DatabaseSync(".local/host-journal.sqlite", { readOnly: true });
  const physical = journal.prepare("SELECT COUNT(*) AS count FROM operations WHERE run_id=?").get(run.id) as { count: number };
  journal.close();
  assert.equal(final.status, "failed");
  assert.match(final.error, /未执行/);
  assert.equal(closed.code, "approval_closed");
  assert.equal(calls.rows[0].status, "failed");
  assert.match(calls.rows[0].result.error, /未执行/);
  assert.equal(physical.count, 0);
  console.log(JSON.stringify({ runId: run.id, status: final.status,
    approval: closed.code, tool: calls.rows[0].status, physicalOperations: physical.count }));
} finally {
  await pool.end();
}
