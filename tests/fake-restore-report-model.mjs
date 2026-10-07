import { createServer } from "node:http";
import { sendOpenAI } from "./fake-stream.mjs";

const source = "https://raw.githubusercontent.com/chyroc/open-muse/b40fb7bb4c809f6a1ec2a47972921f799d47fbf0/README.zh-CN.md";
const markdown = `# Open Muse 恢复验证报告

## 结论
这份报告用于验证 OpenGrok Bot 在备份恢复后仍能打开旧成果。它在隔离测试库中生成，不代表对 Open Muse 功能完整性的评估。

## 依据
测试任务要求使用可见浏览器打开并读取固定版本的公开文件，然后将带来源的 Markdown 保存为成果。成果文件、数据库记录及下载响应会分别核对字节数和 SHA-256。

## 来源
- ${source}
`;

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const used = input.messages.filter(message => message.role === "tool").length;
  const calls = [
    ["browser_open", { url: source }],
    ["browser_read", {}],
    ["publish_report", { title: "Open Muse 恢复验证", markdown, sources: [source] }],
  ];
  const next = calls[used];
  const message = next ? { role: "assistant", content: null,
    tool_calls: [{ id: `restore_call_${used + 1}`, type: "function",
      function: { name: next[0], arguments: JSON.stringify(next[1]) } }],
  } : { role: "assistant", content: "报告已发布。" };
  sendOpenAI(response, input, {
    id: `restore-test-${used}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
    model: input.model || "restore-report", choices: [{ index: 0, message,
      finish_reason: next ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
  });
}).listen(3856, "127.0.0.1", () => console.log("restore report model ready"));
