import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { DatabaseSync } from "node:sqlite";

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

await api("/login", "POST", { username: "smoke", password: testPassword });
const profile = (await api("/model-profiles")).profiles.find(item => item.provider === "openai-compatible" && item.baseUrl === "http://127.0.0.1:3850/v1");
const bot = (await api("/bots", "POST", {
  name: `Fault ${Date.now()}`, description: "", instructions: "", modelProfileId: profile.id,
})).bot;
const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
  text: "研究 Example Domain 并生成报告", requestId: randomUUID(), deliverable: "report",
});
let final;
for (let attempt = 0; attempt < 80; attempt++) {
  final = (await api(`/runs/${submitted.run.id}`)).run;
  if (["succeeded", "failed"].includes(final.status)) break;
  await new Promise(resolve => setTimeout(resolve, 300));
}
const response = await fetch(`${base}/runs/${submitted.run.id}/events?after=0`, {
  headers: { cookie }, signal: AbortSignal.timeout(10_000),
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffered = "";
const events = [];
try {
  while (!events.some(event => event.kind === "succeeded")) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split("\n\n");
    buffered = frames.pop();
    for (const frame of frames) {
      const line = frame.split("\n").find(item => item.startsWith("data: "));
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
} finally { await reader.cancel(); }
const unknown = events.filter(event => event.kind === "tool_unknown");
const reconciled = events.filter(event => event.kind === "tool_reconciled");
const artifacts = (await api(`/runs/${submitted.run.id}/artifacts`)).artifacts;
const journal = new DatabaseSync(".local/host-journal.sqlite", { readOnly: true });
const navigationCount = journal.prepare(
  "SELECT count(*) AS count FROM operations WHERE run_id=? AND name='browser_open'",
).get(submitted.run.id).count;
journal.close();
console.log(JSON.stringify({ status: final.status, unknown: unknown.length,
  reconciled: reconciled.length, artifacts: artifacts.length, navigationCount }));
if (final.status !== "succeeded" || unknown.length !== 1 ||
  reconciled.length !== 1 || artifacts.length !== 1 || navigationCount !== 1) process.exitCode = 1;
