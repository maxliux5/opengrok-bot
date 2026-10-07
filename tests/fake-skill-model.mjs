import { createServer } from "node:http";

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const system = input.messages.filter(message => message.role === "system")
    .map(message => String(message.content)).join("\n");
  const content = JSON.stringify({
    currentVersion: system.includes("网页事实核验新版 (v2)"),
    currentStep: system.includes("先确认网页来源。"),
    oldStep: system.includes("逐项核对结论与页面文本。"),
    capabilityDenied: system.includes("当前权限不足，不能使用"),
  });
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: "chatcmpl-skill-probe", object: "chat.completion", created: Math.floor(Date.now() / 1000),
    model: input.model || "skill-probe", choices: [{ index: 0,
      message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
  }));
}).listen(3857, "127.0.0.1", () => console.log("skill probe model ready"));
