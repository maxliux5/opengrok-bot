import { createServer } from "node:http";
import { sendAnthropic, sendOpenAI } from "./fake-stream.mjs";

export async function startOnboardingModel() {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !["/v1/chat/completions", "/v1/messages"].includes(request.url)) {
      response.writeHead(404).end(); return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    requests.push(input);
    if (input.model === "denied") {
      response.writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "private-upstream-detail fixture-secret", type: "authentication_error" } }));
      return;
    }
    if (input.model === "slow" || input.model === "timeout") {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, input.model === "timeout" ? 21_000 : 1200);
        response.once("close", () => { clearTimeout(timer); resolve(); });
      });
      if (response.destroyed) return;
    }
    const userText = JSON.stringify(input.messages.filter(message => message.role === "user"));
    const nonce = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.exec(userText)?.[0];
    const probe = userText.includes("Connection test.");
    const toolProbe = input.tools?.some(item => (item.function?.name || item.name) === "connection_check");
    const used = input.messages.filter(message => message.role === "tool").length;
    const report = "# Example Domain\n\n## 结论\n该页面提供用于文档示例的域名。\n\n## 依据\n页面说明此域名可用于文档中的示例，不需要事先获得许可；同时提醒避免将它用于实际运行的业务。以上结论只涉及已经读取的页面。\n\n## 来源\n- https://example.com/\n";
    const actions = [["browser_open", { url: "https://example.com/" }], ["browser_read", {}],
      ["publish_report", { title: "Example Domain 首份报告", markdown: report, sources: ["https://example.com/"] }]];
    const next = probe ? toolProbe && input.model !== "bad-tool" ? ["connection_check", { nonce }] : null : actions[used];
    const content = probe ? nonce || "unexpected" : "报告已发布。";
    if (request.url === "/v1/messages") {
      sendAnthropic(response, input, { id: "msg_onboarding", type: "message", role: "assistant", model: input.model,
        content: next ? [{ type: "tool_use", id: "tool_probe", name: next[0], input: next[1] }] : [{ type: "text", text: content }],
        stop_reason: next ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 30, output_tokens: 20 } });
    } else {
      sendOpenAI(response, input, { id: `chatcmpl-onboarding-${used}`, object: "chat.completion",
        created: Math.floor(Date.now() / 1000), model: input.model,
        choices: [{ index: 0, message: next ? { role: "assistant", content: null,
          tool_calls: [{ id: `call_${used}`, type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] }
          : { role: "assistant", content }, finish_reason: next ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } });
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}
