import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { query, pool } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
let cookie = "";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: "Broken stream test", provider: "openai-compatible", modelId: "broken-stream",
    baseUrl: "http://127.0.0.1:3853/v1",
  })).profile;
  const bot = (await api("/bots", "POST", {
    name: `Stream interruption ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id,
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "请研究 Example Domain。", requestId: randomUUID(), deliverable: "answer",
  });
  const runId = submitted.run.id;
  let run = submitted.run;
  for (let attempt = 0; attempt < 100; attempt++) {
    run = (await api(`/runs/${runId}`)).run;
    if (["succeeded", "failed", "canceled", "reconciling"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const partial = await api(`/runs/${runId}/partial`);
  const steps = await query<{ status: string; output_snapshot: { text?: string } | null }>(
    "SELECT status,output_snapshot FROM model_steps WHERE run_id=$1 ORDER BY ordinal", [runId],
  );
  const calls = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM tool_calls WHERE run_id=$1", [runId],
  );
  console.log(JSON.stringify({ runId, status: run.status, error: run.error,
    partial, steps: steps.rows, toolCalls: Number(calls.rows[0].count) }));
  if (run.status !== "failed" || !run.error?.includes("模型响应在完成前中断") ||
    partial.status !== "interrupted" ||
    !partial.text.includes("这是一段未完成的回复") ||
    steps.rows.some(step => step.status !== "interrupted") ||
    Number(calls.rows[0].count) !== 0) process.exitCode = 1;
} finally {
  await pool.end();
}
