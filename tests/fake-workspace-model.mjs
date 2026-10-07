import { createServer } from "node:http";
import { sendOpenAI } from "./fake-stream.mjs";

function toolResult(message) {
  try { return JSON.parse(message?.content || "{}"); }
  catch { return {}; }
}

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const user = input.messages.filter(message => message.role === "user")
    .map(message => String(message.content)).join("\n");
  const mode = user.match(/mode=(create|overwrite|reject)/)?.[1];
  const path = user.match(/path=(runs\/[a-f0-9-]{36}\/note\.txt)/)?.[1];
  const results = input.messages.filter(message => message.role === "tool");
  if (!mode || !path) {
    response.writeHead(400).end(JSON.stringify({ error: "Missing test mode or path" }));
    return;
  }
  const used = results.length;
  const next = mode === "create" ? [
    ["workspace_write", { path, content: "第一版工作文件\n" }],
    ["workspace_read", { path }],
    ["workspace_list", { path: path.slice(0, -"/note.txt".length) }],
  ][used] : mode === "overwrite" ? [
    ["workspace_read", { path }],
    ["workspace_write", { path, content: "第二版工作文件\n",
      expectedSha256: toolResult(results[0]).sha256 }],
    ["workspace_read", { path }],
  ][used] : used === 0 ? ["workspace_write", { path, content: "误覆盖\n" }] : null;
  const message = next ? {
    role: "assistant", content: null,
    tool_calls: [{ id: `call_workspace_${used + 1}`, type: "function",
      function: { name: next[0], arguments: JSON.stringify(next[1]) } }],
  } : { role: "assistant", content: mode === "reject" ?
    "已有文件，缺少当前摘要，覆盖已被拒绝。" : "工作文件已按实际工具结果核对。" };
  sendOpenAI(response, input, {
    id: `chatcmpl-workspace-${used}`, object: "chat.completion",
    created: Math.floor(Date.now() / 1000), model: input.model || "workspace-test",
    choices: [{ index: 0, message, finish_reason: next ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
  });
}).listen(3854, "127.0.0.1", () => console.log("workspace fake model ready"));
