import { createServer } from "node:http";

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  for await (const _chunk of request) { /* Consume the request before returning a broken stream. */ }
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  const base = { id: "chatcmpl-broken", object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model: "broken-stream" };
  const send = delta => response.write(`data: ${JSON.stringify({ ...base,
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`);
  send({ role: "assistant" });
  send({ content: "这是一段未完成的回复。" });
  send({ tool_calls: [{ index: 0, id: "call_unfinished", type: "function",
    function: { name: "browser_open", arguments: '{"url":"https://example.com' } }] });
  setTimeout(() => response.destroy(), 120);
}).listen(3853, "127.0.0.1", () => console.log("broken stream model ready"));
