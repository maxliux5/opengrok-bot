import { createServer } from "node:http";
import { sendOpenAI } from "./fake-stream.mjs";

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const used = input.messages.filter(message => message.role === "tool").length;
  const next = [
    ["browser_open", { url: "https://example.com/" }],
    ["browser_screenshot", {}],
  ][used];
  const message = next ? { role: "assistant", content: null,
    tool_calls: [{ id: `call_screenshot_${used + 1}`, type: "function",
      function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } :
    { role: "assistant", content: "网页截图已发布为成果。" };
  sendOpenAI(response, input, {
    id: `chatcmpl-screenshot-${used}`, object: "chat.completion",
    created: Math.floor(Date.now() / 1000), model: input.model || "screenshot-test",
    choices: [{ index: 0, message, finish_reason: next ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 },
  });
}).listen(3855, "127.0.0.1", () => console.log("screenshot fake model ready"));
