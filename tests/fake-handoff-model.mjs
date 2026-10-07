import { createServer } from "node:http";

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const userText = input.messages.filter(message => message.role === "user")
    .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
  const toolText = input.messages.filter(message => message.role === "tool")
    .map(message => JSON.stringify(message.content)).join("\n");
  const used = input.messages.filter(message => message.role === "tool").length;
  let next = null;
  let answer = "普通测试任务完成。";
  if (userText.includes("AGENT_DELEGATE")) {
    const target = userText.match(/target=([0-9a-f-]{36})/i)?.[1];
    const artifact = userText.match(/artifact=([0-9a-f-]{36})/i)?.[1];
    if (!target || !artifact) throw new Error("fixture target or artifact missing");
    if (!used) next = ["delegate_to_bot", { targetBotId: target,
      task: "读取上游材料并核对结果", acceptance: "引用成果后说明结果 42",
      deliverable: "answer", artifactIds: [artifact] }];
    else answer = "材料已交接给复核 Bot。";
  } else if (userText.includes("可读取的上游成果")) {
    const artifact = [...userText.matchAll(/([0-9a-f-]{36})/ig)].at(-1)?.[1];
    if (!artifact) throw new Error("fixture handoff artifact missing");
    if (!used) next = ["read_handoff_artifact", { artifactId: artifact, offset: 0, limit: 8000 }];
    else answer = toolText.includes("42") ? "已读取上游成果，结果为 42。" : "成果回读失败。";
  }
  const message = next ? { role: "assistant", content: null, tool_calls: [{
    id: `call_${used + 1}`, type: "function",
    function: { name: next[0], arguments: JSON.stringify(next[1]) },
  }] } : { role: "assistant", content: answer };
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    id: `chatcmpl-handoff-${used}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
    model: input.model || "handoff-fixture", choices: [{ index: 0, message,
      finish_reason: next ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 },
  }));
}).listen(3850, "127.0.0.1", () => console.log("handoff fixture model ready"));
