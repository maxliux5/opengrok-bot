import { randomUUID } from "node:crypto";
import { generateText, streamText, tool } from "ai";
import { z } from "zod";
import type { ModelProbeResult, SetupCheck } from "@opengrok/contracts";
import { providerModel, validateModelConnection, type ModelConfiguration } from "./model.js";

export async function probeModel(profile: Pick<ModelConfiguration,
  "provider" | "modelId" | "baseUrl" | "apiKey" | "capabilities">): Promise<ModelProbeResult> {
  validateModelConnection(profile);
  const started = Date.now();
  const signal = AbortSignal.timeout(20_000);
  const nonce = randomUUID();
  const checks: SetupCheck[] = [];
  try {
    const options = {
      model: providerModel(profile),
      prompt: profile.capabilities.tools
        ? `Connection test. Call connection_check once with nonce exactly "${nonce}". Do not perform any other action.`
        : `Connection test. Reply with exactly "${nonce}".`,
      tools: profile.capabilities.tools ? {
        connection_check: tool({ description: "Return the supplied nonce. This tool has no side effects.",
          inputSchema: z.object({ nonce: z.string() }) }),
      } : undefined,
      maxOutputTokens: 256,
      maxRetries: 0,
      abortSignal: signal,
    };
    let text: string;
    let calls: Array<{ toolName: string; input: unknown }>;
    if (profile.capabilities.streaming) {
      // Provider error bodies can contain secrets; classify stream errors below.
      const result = streamText({ ...options, onError: () => {} });
      for await (const part of result.stream) {
        if (part.type === "error") throw part.error;
        if (part.type === "abort") throw new Error("aborted");
      }
      text = await result.text;
      calls = await result.toolCalls;
    } else {
      const result = await generateText(options);
      text = result.text;
      calls = result.toolCalls;
    }
    const matched = profile.capabilities.tools
      ? calls.length === 1 && calls[0].toolName === "connection_check" &&
        z.object({ nonce: z.literal(nonce) }).safeParse(calls[0].input).success
      : text.trim() === nonce;
    checks.push({ id: "response", label: "模型响应", status: matched ? "ok" : "error",
      detail: matched ? "短请求与回读校验通过" : "返回内容未通过校验，请核对模型 ID 和能力配置" });
    checks.push({ id: "tools", label: "工具调用",
      status: profile.capabilities.tools ? matched ? "ok" : "error" : "unchecked",
      detail: profile.capabilities.tools ? matched ? "测试参数回传正确，未执行外部操作" : "未收到预期的工具调用" : "未启用" });
    checks.push({ id: "streaming", label: "流式输出", status: profile.capabilities.streaming ? "ok" : "unchecked",
      detail: profile.capabilities.streaming ? "响应流完整结束" : "使用非流式响应" });
  } catch (error) {
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    const detail = signal.aborted ? "模型测试超过 20 秒，请检查地址和服务状态" :
      status === 401 || status === 403 ? "模型鉴权失败，请检查 API Key 和访问权限" :
      status === 404 ? "找不到模型或接口，请检查 API 地址和模型 ID" :
      status === 429 ? "模型服务限流或额度不足，请稍后重试" :
      "模型连接或响应解析失败，请检查协议、地址和能力配置";
    checks.push({ id: "response", label: "模型响应", status: "error", detail });
  }
  checks.push({ id: "vision", label: "视觉输入", status: "unchecked",
    detail: profile.capabilities.vision ? "尚未测试图片识别" : "未启用" });
  return { ok: checks.every(check => check.status !== "error"), durationMs: Date.now() - started, checks };
}
