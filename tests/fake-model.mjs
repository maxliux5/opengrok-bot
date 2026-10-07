import { createServer } from "node:http";
import { sendOpenAI } from "./fake-stream.mjs";

const report = `# Example Domain 研究报告\n\n## 结论\nExample Domain 是面向文档示例的域名。页面明确提示这个域名不应依赖于测试或监控服务。\n\n## 依据\n我在浏览器中打开并读取了页面正文。页面包含多语言说明，英文与中文内容都描述了相同的用途。\n\n## 来源\n- https://example.com/\n`;

createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const used = input.messages.filter(message => message.role === "tool").length;
  const userText = input.messages.filter(message => message.role === "user")
    .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  if (userText.includes("服务重启验证") && used === 0) await new Promise(resolve => setTimeout(resolve, 5000));
  else if (userText.includes("离线")) await new Promise(resolve => setTimeout(resolve, 1200));
  const hasMemory = input.messages.filter(message => message.role === "system")
    .some(message => String(message.content).includes("报告使用中文，并包含结论、依据和来源三个标题"));
  const calls = [
    ["browser_open", { url: "https://example.com" }],
    ["browser_read", {}],
    ["publish_report", { title: "Example Domain 研究报告", markdown: report, sources: ["https://example.com/"] }],
  ];
  const memoryRequest = userText.includes("记住");
  const memoryRecall = userText.includes("已有偏好");
  const shellRequest = userText.includes("创建测试文件");
  const inflightCancel = userText.includes("取消在途测试");
  const shellRejected = userText.includes("拒绝");
  const toolFailed = input.messages.filter(message => message.role === "tool")
    .some(message => JSON.stringify(message.content).includes("用户拒绝执行命令"));
  const withoutUsage = userText.includes("无用量");
  const next = inflightCancel && used === 0 ? ["shell_exec", {
    command: "sleep 6", timeoutMs: 10_000,
  }] : inflightCancel ? null : shellRequest && used === 0 ? ["shell_exec", {
    command: shellRejected ? "printf 'rejected-command' > /workspace/approval-reject.txt" :
      "printf 'approved-command' > /workspace/approval-smoke.txt", timeoutMs: 10000,
  }] : shellRequest || withoutUsage ? null : memoryRequest && used === 0 ? ["remember", {
    kind: "preference", content: "报告使用中文，并包含结论、依据和来源三个标题",
  }] : memoryRequest || memoryRecall ? null : calls[used];
  const message = next ? {
    role: "assistant", content: null,
    tool_calls: [{ id: `call_${used + 1}`, type: "function",
      function: { name: next[0], arguments: JSON.stringify(next[1]) } }],
  } : { role: "assistant", content: inflightCancel ? "在途命令已经结束。" : withoutUsage ? "无用量测试完成。" : shellRequest ? toolFailed ? "用户拒绝命令，未创建文件。" : "命令已执行，文件已创建。" : memoryRequest ? "偏好已保存。" : memoryRecall ?
    hasMemory ? "已沿用偏好：报告使用中文，并包含结论、依据和来源三个标题。" : "未找到当前 Bot 的报告偏好。" :
    userText.includes("补充验证标记ABC") ? "报告已发布，已收到补充验证标记ABC。" :
    "报告已发布，页面说明与来源已写入成果。" };
  const output = {
    id: `chatcmpl-test-${used}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
    model: input.model || "test-model", choices: [{ index: 0, message,
      finish_reason: next ? "tool_calls" : "stop" }],
    usage: withoutUsage ? undefined : { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  };
  sendOpenAI(response, input, output);
}).listen(3850, "127.0.0.1", () => console.log("fake model ready"));
