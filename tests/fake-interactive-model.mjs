import { createServer } from "node:http";
import { sendOpenAI } from "./fake-stream.mjs";

function toolResult(message) {
  const content = Array.isArray(message.content)
    ? message.content.map(part => part.text || part.value || "").join("")
    : message.content;
  try { return JSON.parse(content); }
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
  const results = input.messages.filter(message => message.role === "tool").map(toolResult);
  const used = results.length;
  const observed = [...results].reverse().find(item => item.observationId && item.elements);
  const field = observed?.elements?.find(item => item.kind === "textbox" && item.label.includes("Text input"));
  const checkbox = observed?.elements?.find(item => item.kind === "button" && item.label.includes("Default checkbox"));
  const actions = [
    ["browser_read", {}],
    field && ["browser_fill", { observationId: observed.observationId, ref: field.ref, value: "OpenGrok interaction test" }],
    ["browser_read", {}],
    checkbox && ["browser_click", { observationId: observed.observationId, ref: checkbox.ref }],
    ["browser_read", {}],
  ];
  const next = actions[used];
  const message = next ? {
    role: "assistant", content: null,
    tool_calls: [{ id: `call_${used + 1}`, type: "function",
      function: { name: next[0], arguments: JSON.stringify(next[1]) } }],
  } : { role: "assistant", content: "表单已由可见浏览器处理。" };
  sendOpenAI(response, input, {
    id: `chatcmpl-interactive-${used}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
    model: input.model || "test-model", choices: [{ index: 0, message,
      finish_reason: next ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  });
}).listen(3852, "127.0.0.1", () => console.log("interactive fake model ready"));
