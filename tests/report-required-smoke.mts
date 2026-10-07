import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { query, pool } from "../packages/core/src/db.ts";

const base = "http://127.0.0.1:3841/api";
let cookie = "";

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: "Screenshot only model", provider: "openai-compatible", modelId: "screenshot-test",
    baseUrl: "http://127.0.0.1:3855/v1",
  })).profile;
  const bot = (await api("/bots", "POST", { name: `Report guard ${Date.now()}`,
    description: "", instructions: "", modelProfileId: profile.id })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "生成 Markdown 报告，截图不能替代报告。", requestId: randomUUID(), deliverable: "report",
  });
  let run;
  for (let attempt = 0; attempt < 90; attempt++) {
    run = (await api(`/runs/${submitted.run.id}`)).run;
    if (["succeeded", "failed", "canceled"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const artifacts = (await api(`/runs/${submitted.run.id}/artifacts`)).artifacts;
  const steps = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM model_steps WHERE run_id=$1", [submitted.run.id],
  );
  console.log(JSON.stringify({ runId: run?.id, status: run?.status, error: run?.error,
    expectedArtifact: run?.expectedArtifact,
    images: artifacts.filter((item: { mimeType: string }) => item.mimeType === "image/png").length,
    reports: artifacts.filter((item: { mimeType: string }) =>
      item.mimeType === "text/markdown; charset=utf-8").length,
    steps: Number(steps.rows[0].count), resultText: run?.resultText }));
  if (run?.status !== "failed" || !run.expectedArtifact || run.resultText ||
    Number(steps.rows[0].count) > 4 ||
    !artifacts.some((item: { mimeType: string }) => item.mimeType === "image/png") ||
    artifacts.some((item: { mimeType: string }) => item.mimeType === "text/markdown; charset=utf-8")) {
    process.exitCode = 1;
  }
} finally { await pool.end(); }
