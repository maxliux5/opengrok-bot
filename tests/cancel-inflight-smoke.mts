import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pool, query } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
const expectRecovery = process.env.OPENGROK_EXPECT_RECOVERY === "1";
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let cookie = "";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: `In-flight cancel ${Date.now()}`, provider: "openai-compatible",
    modelId: "test-model", baseUrl: "http://127.0.0.1:3850/v1",
  })).profile;
  const bot = (await api("/bots", "POST", {
    name: `In-flight cancel ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id, capabilities: ["shell"],
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "取消在途测试：运行一次受控的短暂等待命令。", requestId: randomUUID(), deliverable: "answer",
  });
  const runId = submitted.run.id;
  let approval: { id: string; toolName: string; args: { command: string } } | undefined;
  for (let attempt = 0; attempt < 80; attempt++) {
    approval = (await api("/approvals")).approvals.find((item: { runId: string }) => item.runId === runId);
    if (approval) break;
    await wait(100);
  }
  assert.ok(approval, "任务未进入审批等待");
  assert.equal(approval.toolName, "shell_exec");
  assert.equal(approval.args.command, "sleep 6");
  await api(`/approvals/${approval.id}/decision`, "POST", { decision: "approve" });

  const journal = new DatabaseSync(".local/host-journal.sqlite", { readOnly: true });
  try {
    const runtimeToken = (await readFile(".local/desktop.env", "utf8")).trim().split("=", 2)[1];
    const hostToken = (await readFile(".local/host.token", "utf8")).trim();
    let active = false;
    let operationId = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = journal.prepare("SELECT operation_id,status FROM operations WHERE run_id=?").get(runId) as
        { operation_id: string; status: string } | undefined;
      if (row?.status === "dispatching") {
        const response = await fetch("http://127.0.0.1:3843/health", {
          headers: { authorization: `Bearer ${runtimeToken}` },
        });
        active = response.ok && (await response.json()).busy === true;
        if (active) { operationId = row.operation_id; break; }
      }
      await wait(100);
    }
    assert.equal(active, true, "终端命令未进入运行时的在途执行状态");
    const prematureStop = await fetch(`http://127.0.0.1:3844/operations/${operationId}/stop`, {
      method: "POST", headers: { authorization: `Bearer ${hostToken}` },
    });
    assert.equal(prematureStop.status, 409, "未取消的任务不应获得终端停止权限");
    const cancelStartedAt = Date.now();
    const requested = (await api(`/runs/${runId}/cancel`, "POST")).run;
    assert.equal(requested.status, "canceling");
    const during = (await api(`/runs/${runId}`)).run;
    assert.ok(["canceling", "canceled"].includes(during.status));

    let finished = during;
    const statuses = new Set<string>([requested.status, during.status]);
    for (let attempt = 0; attempt < 200 && finished.status !== "canceled"; attempt++) {
      await wait(100);
      finished = (await api(`/runs/${runId}`)).run;
      statuses.add(finished.status);
    }
    assert.equal(finished.status, "canceled");
    const operations = journal.prepare("SELECT name,status,result_json FROM operations WHERE run_id=?").all(runId) as
      Array<{ name: string; status: string; result_json: string | null }>;
    assert.deepEqual(operations.map(({ name, status }) => ({ name, status })),
      [{ name: "shell_exec", status: "succeeded" }]);
    const receipt = JSON.parse(operations[0].result_json || "null");
    assert.equal(receipt.stoppedByUser, true);
    assert.equal(receipt.timedOut, false);
    assert.equal(receipt.signal, "SIGTERM");
    const calls = await query<{ status: string }>("SELECT status FROM tool_calls WHERE run_id=$1", [runId]);
    const slot = await query<{ active_run_id: string | null }>(
      "SELECT active_run_id FROM bot_execution_slots WHERE bot_id=$1", [bot.id]);
    assert.equal(calls.rows[0].status, "succeeded");
    assert.equal(slot.rows[0].active_run_id, null);
    const events = (await query<{ kind: string }>(
      "SELECT kind FROM run_events WHERE run_id=$1 ORDER BY sequence", [runId],
    )).rows.map(item => item.kind);
    if (expectRecovery) {
      assert.ok(events.indexOf("tool_unknown") < events.indexOf("tool_reconciled"));
      assert.ok(events.indexOf("tool_reconciled") < events.indexOf("canceled"));
      assert.ok(events.includes("tool_unknown") && events.includes("tool_reconciled"));
    }
    console.log(JSON.stringify({ runId, requested: requested.status, final: finished.status,
      operations: operations.map(({ name, status }) => ({ name, status })),
      signal: receipt.signal, stoppedByUser: receipt.stoppedByUser,
      cancelDurationMs: Date.now() - cancelStartedAt,
      call: calls.rows[0].status, statuses: [...statuses], expectRecovery,
      recoveryEvents: expectRecovery ? events.filter(item =>
        ["tool_unknown", "tool_reconciled", "canceled"].includes(item)) : [],
      slotReleased: slot.rows[0].active_run_id === null }));
  } finally { journal.close(); }
} finally {
  await pool.end();
}
