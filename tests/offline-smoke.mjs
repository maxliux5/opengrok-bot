import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";

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

async function nextEvent(response, requiredKind) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE ended before expected event");
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop();
      for (const frame of frames) {
        const line = frame.split("\n").find(item => item.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (!requiredKind || event.kind === requiredKind) return event;
      }
    }
  } finally { await reader.cancel(); }
}

await api("/login", "POST", { username: "smoke", password: testPassword });
const profile = (await api("/model-profiles")).profiles.find(item => item.provider === "openai-compatible" && item.baseUrl === "http://127.0.0.1:3850/v1");
const bot = (await api("/bots", "POST", {
  name: `Offline ${Date.now()}`, description: "", instructions: "", modelProfileId: profile.id,
})).bot;
const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
const body = { text: "离线研究 Example Domain 并生成报告", requestId: randomUUID(), deliverable: "report" };
const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", body);
const repeated = await api(`/conversations/${conversation.id}/messages`, "POST", body);
const connection = await fetch(`${base}/runs/${submitted.run.id}/events?after=0`, {
  headers: { cookie }, signal: AbortSignal.timeout(15_000),
});
const first = await nextEvent(connection);
connection.body.cancel().catch(() => undefined);
let final;
for (let attempt = 0; attempt < 40; attempt++) {
  final = (await api(`/runs/${submitted.run.id}`)).run;
  if (["succeeded", "failed", "reconciling"].includes(final.status)) break;
  await new Promise(resolve => setTimeout(resolve, 300));
}
const resumed = await fetch(`${base}/runs/${submitted.run.id}/events`, {
  headers: { cookie, "last-event-id": String(first.sequence) }, signal: AbortSignal.timeout(15_000),
});
const last = await nextEvent(resumed, "succeeded");
console.log(JSON.stringify({ first: first.kind, firstSequence: first.sequence,
  final: final.status, last: last.kind, lastSequence: last.sequence,
  sameRun: repeated.run.id === submitted.run.id,
  sameMessage: repeated.message.id === submitted.message.id }));
if (final.status !== "succeeded" || last.sequence <= first.sequence ||
  repeated.run.id !== submitted.run.id || repeated.message.id !== submitted.message.id) process.exitCode = 1;
