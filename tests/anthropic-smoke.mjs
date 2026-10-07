import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { Pool } = createRequire(new URL("../packages/core/package.json", import.meta.url))("pg");
const pool = new Pool({ host: fileURLToPath(new URL("../.local/", import.meta.url)),
  port: 55432, database: "opengrok_test", user: process.env.USER });

const base = "http://127.0.0.1:3841/api";
let cookie = "";
async function api(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

let profileId;
try {
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const profile = (await api("/model-profiles", "POST", {
    name: "Anthropic protocol smoke", provider: "anthropic", modelId: "test-anthropic",
    baseUrl: "http://127.0.0.1:3851/v1", apiKey: "test-only-key",
  })).profile;
  profileId = profile.id;
  const bot = (await api("/bots", "POST", {
    name: `Anthropic ${Date.now()}`, description: "", instructions: "", modelProfileId: profile.id,
  })).bot;
  const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
  const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
    text: "研究 Example Domain 并生成带来源的报告", requestId: randomUUID(), deliverable: "report",
  });
  let run;
  for (let attempt = 0; attempt < 50; attempt++) {
    run = (await api(`/runs/${submitted.run.id}`)).run;
    if (["succeeded", "failed", "reconciling"].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const artifacts = (await api(`/runs/${submitted.run.id}/artifacts`)).artifacts;
  console.log(JSON.stringify({ status: run.status, error: run.error,
    resultText: run.resultText, artifactCount: artifacts.length }));
  if (run.status !== "succeeded" || artifacts.length !== 1) process.exitCode = 1;
} finally {
  if (profileId) await pool.query(
    "UPDATE model_profiles SET encrypted_api_key=NULL WHERE id=$1", [profileId]);
  await pool.end();
}
