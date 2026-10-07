import { createServer } from "node:http";
import { sendAnthropic } from "./fake-stream.mjs";

const report = `# Example Domain 研究报告\n\n## 结论\nExample Domain 是供文档示例使用的域名。网站指出不应把它作为测试和监控服务。\n\n## 依据\n我通过同一台可见的 Linux 电脑打开页面并读取正文。页面提供多种语言的同义说明，其中包括英文和中文。\n\n## 来源\n- https://example.com/\n`;
const calls = [
  ["browser_open", { url: "https://example.com" }],
  ["browser_read", {}],
  ["publish_report", { title: "Example Domain 研究报告", markdown: report, sources: ["https://example.com/"] }],
];

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/messages") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const used = (JSON.stringify(input.messages).match(/"type":"tool_result"/g) || []).length;
  const next = calls[used];
  const output = {
    id: `msg_fake_${used}`, type: "message", role: "assistant", model: input.model || "test-anthropic",
    content: next ? [{ type: "tool_use", id: `toolu_fake_${used}`, name: next[0], input: next[1] }] :
      [{ type: "text", text: "Anthropic 协议报告已发布。" }],
    stop_reason: next ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 50, output_tokens: 30 },
  };
  sendAnthropic(response, input, output);
}).listen(3851, "127.0.0.1", () => console.log("fake Anthropic ready"));
