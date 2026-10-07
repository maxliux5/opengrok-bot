import { randomUUID } from "node:crypto";
import { testPassword } from "./test-password.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const base = "http://127.0.0.1:3841/api";
const formUrl = "https://www.selenium.dev/selenium/web/web-form.html";
const runtimeToken = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];
let cookie = "";

async function api(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

await api("/login", "POST", { username: "smoke", password: testPassword });
const runtimeHeaders = { authorization: `Bearer ${runtimeToken}` };
const response = await fetch("http://127.0.0.1:3843/operation", {
  method: "POST", headers: { ...runtimeHeaders, "content-type": "application/json" },
  body: JSON.stringify({ name: "browser_open", args: { url: formUrl },
    deadline: Date.now() + 60_000 }), signal: AbortSignal.timeout(65_000),
});
if (!response.ok) throw new Error(`Form fixture unavailable: ${await response.text()}`);
const profile = (await api("/model-profiles", "POST", {
  name: "Interactive fake model", provider: "openai-compatible", modelId: "interactive-test",
  baseUrl: "http://127.0.0.1:3852/v1",
})).profile;
const bot = (await api("/bots", "POST", {
  name: `Interactive ${Date.now()}`, description: "", instructions: "", modelProfileId: profile.id,
})).bot;
const conversation = (await api(`/bots/${bot.id}/conversations`, "POST", {})).conversation;
const submitted = await api(`/conversations/${conversation.id}/messages`, "POST", {
  text: "交互测试：在公开测试表单的 Text input 填写测试名字，并勾选 Default checkbox。不要提交。", requestId: randomUUID(), deliverable: "answer",
});

const decisions = [];
let final;
for (let attempt = 0; attempt < 120; attempt++) {
  const pending = (await api("/approvals")).approvals.filter(item => item.runId === submitted.run.id);
  for (const item of pending) {
    const expected = item.toolName === "browser_fill" ?
      item.target.includes("Text input") && item.args.value === "OpenGrok interaction test" :
      item.toolName === "browser_click" && item.target.includes("Default checkbox") &&
      item.target.includes(formUrl);
    if (!expected) throw new Error(`Unexpected approval: ${JSON.stringify(item)}`);
    await api(`/approvals/${item.id}/decision`, "POST", { decision: "approve" });
    decisions.push(item.toolName);
  }
  final = (await api(`/runs/${submitted.run.id}`)).run;
  if (["succeeded", "failed", "canceled", "reconciling"].includes(final.status)) break;
  await new Promise(resolve => setTimeout(resolve, 350));
}

const journal = new DatabaseSync(".local/host-journal.sqlite", { readOnly: true });
const operations = journal.prepare(
  "SELECT name,status,result_json FROM operations WHERE run_id=? ORDER BY created_at",
).all(submitted.run.id).map(item => ({ name: item.name, status: item.status,
  result: JSON.parse(item.result_json || "{}") }));
journal.close();
const click = operations.find(item => item.name === "browser_click");
const fill = operations.find(item => item.name === "browser_fill");
const postRead = operations.filter(item => item.name === "browser_read").at(-1);
console.log(JSON.stringify({ runId: submitted.run.id, status: final?.status, error: final?.error,
  decisions, operations: operations.map(item => ({ name: item.name, status: item.status })),
  clickUrl: click?.result?.url, fillLabel: fill?.result?.label,
  fieldValue: postRead?.result?.elements?.find(item => item.label.includes("Text input"))?.value,
  checkboxChecked: postRead?.result?.elements?.find(item => item.label.includes("Default checkbox"))?.checked }));
if (final?.status !== "succeeded" || decisions.join(",") !== "browser_fill,browser_click" ||
  !fill || fill.status !== "succeeded" || !click || click.status !== "succeeded" ||
  postRead?.result?.elements?.find(item => item.label.includes("Text input"))?.value !== "OpenGrok interaction test" ||
  postRead?.result?.elements?.find(item => item.label.includes("Default checkbox"))?.checked !== true) process.exitCode = 1;
