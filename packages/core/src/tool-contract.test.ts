import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { canonicalJson, modelProfileInput } from "@opengrok/contracts";
import { agentTools, approvalRequiredTools, computerToolNames, isComputerTool,
  generateAgentStep, providerModel, toolInputSchemas, toolRegistry, toolsForCapabilities,
  verifyToolResult } from "./model.js";
import { browserApprovalTarget } from "./approvals.js";

describe("工具与供应商契约", () => {
  it("工具注册表覆盖模型、审批和电脑执行边界", () => {
    const names = Object.keys(toolRegistry).sort();
    expect(Object.keys(agentTools).sort()).toEqual(names);
    expect(Object.keys(toolInputSchemas).sort()).toEqual(names);
    expect(computerToolNames.sort()).toEqual(names.filter(name =>
      toolRegistry[name as keyof typeof toolRegistry].executor === "computer"));
    for (const name of names as Array<keyof typeof toolRegistry>) {
      const policy = toolRegistry[name];
      expect(isComputerTool(name)).toBe(policy.executor === "computer");
      expect(approvalRequiredTools.has(name)).toBe(policy.authorization === "per_call_approval");
      if (policy.executor === "computer") expect(policy.receipt).toBe("host");
      if (policy.replayPolicy === "idempotent") expect(policy.authorization).toBe("automatic");
    }
  });

  it("参数摘要不受对象键顺序影响", () => {
    expect(canonicalJson({ b: 2, a: { y: 1, x: 3 } })).toBe(
      canonicalJson({ a: { x: 3, y: 1 }, b: 2 }),
    );
  });

  it("模型只收到 Bot 当前授权的工具", () => {
    expect(Object.keys(toolsForCapabilities(["public_web"])).sort()).toEqual([
      "browser_click", "browser_fill", "browser_open", "browser_read", "browser_screenshot",
    ]);
    expect(Object.keys(toolsForCapabilities(["workspace"])).sort()).toEqual([
      "workspace_list", "workspace_read", "workspace_write",
    ]);
    expect(Object.keys(toolsForCapabilities([]))).toEqual([]);
  });

  it("工作文件回执必须匹配请求路径、字节数和摘要", () => {
    const args = { path: "notes/example.txt", content: "中文 hello" };
    const bytes = Buffer.from(args.content, "utf8");
    const result = { path: args.path, sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length, created: true };
    expect(verifyToolResult("workspace_write", args, result)).toEqual(result);
    expect(() => verifyToolResult("workspace_write", args, { ...result, path: "other.txt" }))
      .toThrow(/路径不匹配/);
    expect(() => verifyToolResult("workspace_write", args, { ...result, sizeBytes: 1 }))
      .toThrow(/摘要不匹配/);
    expect(() => verifyToolResult("workspace_read", { path: args.path },
      { path: args.path, content: args.content, sha256: "0".repeat(64), sizeBytes: bytes.length }))
      .toThrow(/摘要不匹配/);
    expect(() => verifyToolResult("browser_open", { url: "https://example.com/" },
      { url: "file:///etc/passwd", title: "wrong", sessionId: "bad", generation: 1, controlEpoch: 1 }))
      .toThrow(/回执格式无效/);
  });

  it("报告必须有足够内容和实际来源", () => {
    expect(() => toolInputSchemas.publish_report.parse({
      title: "研究", markdown: "太短", sources: [],
    })).toThrow();
    expect(toolInputSchemas.publish_report.parse({
      title: "研究", markdown: "报告正文".repeat(35), sources: ["https://example.com/"],
    }).sources).toEqual(["https://example.com/"]);
  });

  it("终端命令有明确时限", () => {
    expect(toolInputSchemas.shell_exec.parse({ command: "pwd" }).timeoutMs).toBe(10_000);
    expect(() => toolInputSchemas.shell_exec.parse({ command: "pwd", timeoutMs: 120_000 })).toThrow();
  });

  it("网页审批绑定最近的观察与元素类型", () => {
    const observationId = "d9cbda7d-4c42-4c6a-91c0-070396187199";
    const observed = { observationId, url: "https://example.com/", elements: [
      { ref: "e1", kind: "link", label: "Learn more", href: "https://www.iana.org/help/example-domains" },
      { ref: "e2", kind: "textbox", label: "Search" },
    ] };
    expect(browserApprovalTarget({ name: "browser_click", args: { observationId, ref: "e1" } }, observed))
      .toContain("Learn more");
    expect(browserApprovalTarget({ name: "browser_fill", args: { observationId, ref: "e2", value: "test" } }, observed))
      .toContain("Search");
    expect(browserApprovalTarget({ name: "browser_click", args: { observationId, ref: "e2" } }, observed)).toBeNull();
    expect(browserApprovalTarget({ name: "browser_click", args: { observationId, ref: "e1" } },
      { ...observed, observationId: "2a3777ef-9e14-4df4-a0c7-98d21d1f91a8" })).toBeNull();
  });

  it("不同供应商都可构造模型，不触发网络调用", () => {
    const base = { id: "test", name: "test", modelId: "test-model",
      hasApiKey: true, createdAt: new Date().toISOString(),
      capabilities: { text: true as const, tools: true, vision: false, streaming: true } };
    expect(providerModel({ ...base, provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:3850/v1", apiKey: "test" })).toBeDefined();
    expect(providerModel({ ...base, provider: "anthropic",
      baseUrl: "http://127.0.0.1:3851/v1", apiKey: "test" })).toBeDefined();
  });

  it("旧配置默认维持文本、工具和流式，视觉需要显式开启", () => {
    const input = { name: "test", provider: "openai-compatible" as const,
      modelId: "test-model", baseUrl: "http://127.0.0.1:3850/v1" };
    expect(modelProfileInput.parse(input).capabilities).toEqual({
      text: true, tools: true, vision: false, streaming: true,
    });
    expect(() => modelProfileInput.parse({ ...input, capabilities: {
      text: false, tools: true, vision: true, streaming: true,
    } })).toThrow();
  });

  it("无工具、非流式配置使用完整响应且不发送工具定义", async () => {
    let sent: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      sent = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion",
        created: 1, model: "test-model", choices: [{ index: 0,
          message: { role: "assistant", content: "完成" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test port");
      const output = await generateAgentStep({
        id: "test", name: "test", provider: "openai-compatible", modelId: "test-model",
        baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: null,
        hasApiKey: false, createdAt: new Date().toISOString(),
        capabilities: { text: true, tools: false, vision: false, streaming: false },
      }, { system: "测试", messages: [{ role: "user", content: "你好" }],
        capabilities: ["public_web"], signal: new AbortController().signal,
        maxOutputTokens: 100, maxCallMs: 5000 });
      expect(output.text).toBe("完成");
      expect(output.toolCalls).toEqual([]);
      expect(sent?.stream).not.toBe(true);
      expect(sent?.tools).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
