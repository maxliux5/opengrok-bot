import { createHash } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { handoffTaskInput, type ModelProfile, type ToolCapability } from "@opengrok/contracts";
import { DomainError } from "./errors.js";

export type ModelConfiguration = ModelProfile & { apiKey: string | null };

type ToolPolicy = {
  description: string;
  inputSchema: z.ZodType;
  resultSchema: z.ZodType;
  capability: ToolCapability;
  executor: "computer" | "service";
  authorization: "automatic" | "per_call_approval";
  replayPolicy: "idempotent" | "reconcile_before_retry" | "manual_only";
  receipt: "host" | "artifact" | "memory" | "handoff" | "github_issue" | "none";
};

const httpUrl = z.url().refine(value => ["http:", "https:"].includes(new URL(value).protocol));
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const pageResult = { url: httpUrl, title: z.string(), sessionId: z.uuid(),
  generation: z.number().int().positive(), controlEpoch: z.number().int().positive() };
const workspaceEntry = z.object({ name: z.string(),
  kind: z.enum(["file", "directory", "blocked_link", "other"]) });

export const toolRegistry = {
  browser_open: {
    description: "在共享 Linux 电脑的可见浏览器中打开一个公共网页。返回实际 URL 和标题。",
    inputSchema: z.object({ url: z.url() }),
    resultSchema: z.object(pageResult),
    capability: "public_web", executor: "computer", authorization: "automatic",
    replayPolicy: "reconcile_before_retry", receipt: "host",
  },
  browser_read: {
    description: "读取共享浏览器当前页面的 URL、标题、可见正文和可操作元素。返回的 observationId/ref 仅对当前页面观察有效。",
    inputSchema: z.object({}),
    resultSchema: z.object({ ...pageResult, text: z.string(), observationId: z.uuid(),
      elements: z.array(z.object({ ref: z.string(), kind: z.enum(["link", "textbox", "button"]),
        label: z.string(), href: z.string().optional(), value: z.string().optional(),
        checked: z.boolean().optional() })).max(60) }),
    capability: "public_web", executor: "computer", authorization: "automatic",
    replayPolicy: "idempotent", receipt: "host",
  },
  browser_screenshot: {
    description: "捕获共享浏览器当前公共网页的 PNG 截图并发布为用户可预览的成果。启用视觉的模型会在下一步收到图像；否则仅收到成果 ID 和摘要，不能据此声称看见截图内容。",
    inputSchema: z.object({}),
    resultSchema: z.object({ artifactId: z.uuid(), sha256, sizeBytes: z.number().int().positive(),
      sources: z.array(httpUrl) }),
    capability: "public_web", executor: "computer", authorization: "automatic",
    replayPolicy: "reconcile_before_retry", receipt: "host",
  },
  browser_click: {
    description: "点击最近一次 browser_read 返回的链接或按钮。传入 observationId 和元素 ref；操作前需要用户逐次批准。",
    inputSchema: z.object({ observationId: z.uuid(), ref: z.string().regex(/^e[1-9]\d{0,2}$/) }),
    resultSchema: z.object({ ...pageResult, action: z.literal("clicked"), label: z.string() }),
    capability: "public_web", executor: "computer", authorization: "per_call_approval",
    replayPolicy: "manual_only", receipt: "host",
  },
  browser_fill: {
    description: "向最近一次 browser_read 返回的非密码文本框输入内容。传入 observationId、元素 ref 和文本；操作前需要用户逐次批准。",
    inputSchema: z.object({
      observationId: z.uuid(), ref: z.string().regex(/^e[1-9]\d{0,2}$/),
      value: z.string().max(2000),
    }),
    resultSchema: z.object({ ...pageResult, action: z.literal("filled"), label: z.string() }),
    capability: "public_web", executor: "computer", authorization: "per_call_approval",
    replayPolicy: "manual_only", receipt: "host",
  },
  desktop_observe: {
    description: "捕获共享 Linux 电脑的完整桌面。桌面可能包含私密内容；启用视觉的模型将在下一步收到图像。返回本次观察 ID、尺寸和截图成果。",
    inputSchema: z.object({}),
    resultSchema: z.object({ artifactId: z.uuid(), sha256, sizeBytes: z.number().int().positive(),
      sources: z.array(httpUrl), observationId: z.uuid(),
      width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
      sessionId: z.uuid(), generation: z.number().int().positive(),
      controlEpoch: z.number().int().positive() }),
    capability: "desktop", executor: "computer", authorization: "automatic",
    replayPolicy: "reconcile_before_retry", receipt: "host",
  },
  desktop_click: {
    description: "在最近一次 desktop_observe 的完整桌面截图坐标处点击。坐标从左上角开始；点击可交互控件的内部中央，避开边框和控件间隙。每次需要用户批准，执行后重新观察确认结果。",
    inputSchema: z.object({ observationId: z.uuid(), x: z.number().int().nonnegative().max(4095),
      y: z.number().int().nonnegative().max(4095), button: z.enum(["left", "right", "double"]).default("left") }),
    resultSchema: z.object({ action: z.literal("click_sent"), x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(), button: z.enum(["left", "right", "double"]),
      sessionId: z.uuid(), generation: z.number().int().positive(),
      controlEpoch: z.number().int().positive() }),
    capability: "desktop", executor: "computer", authorization: "per_call_approval",
    replayPolicy: "manual_only", receipt: "host",
  },
  desktop_key: {
    description: "向最近一次 desktop_observe 的桌面发送一个按键或组合键，例如 Return、Tab、Ctrl+L。每次需要用户批准，执行后重新观察。",
    inputSchema: z.object({ observationId: z.uuid(), key: z.string().min(1).max(40) }),
    resultSchema: z.object({ action: z.literal("key_sent"), key: z.string(),
      sessionId: z.uuid(), generation: z.number().int().positive(),
      controlEpoch: z.number().int().positive() }),
    capability: "desktop", executor: "computer", authorization: "per_call_approval",
    replayPolicy: "manual_only", receipt: "host",
  },
  desktop_type: {
    description: "向最近一次 desktop_observe 的桌面焦点位置粘贴文本，支持 Unicode。每次需要用户批准；密码等敏感内容请由用户接管电脑输入。",
    inputSchema: z.object({ observationId: z.uuid(), text: z.string().min(1).max(2000) }),
    resultSchema: z.object({ action: z.literal("paste_sent"), length: z.number().int().positive(),
      sessionId: z.uuid(), generation: z.number().int().positive(),
      controlEpoch: z.number().int().positive() }),
    capability: "desktop", executor: "computer", authorization: "per_call_approval",
    replayPolicy: "manual_only", receipt: "host",
  },
  workspace_list: {
    description: "列出共享 Linux 电脑 /workspace 中一个相对目录的文件名和类型，不跟随符号链接。省略 path 时列出根目录。",
    inputSchema: z.object({ path: z.string().max(240).default(".") }),
    resultSchema: z.object({ path: z.string(), entries: z.array(workspaceEntry).max(100),
      truncated: z.boolean() }),
    capability: "workspace", executor: "computer", authorization: "automatic",
    replayPolicy: "idempotent", receipt: "host",
  },
  workspace_read: {
    description: "读取 /workspace 内的 UTF-8 文本文件，返回内容及 SHA-256。路径必须相对于 /workspace，最多读取 64 KB。",
    inputSchema: z.object({ path: z.string().min(1).max(240) }),
    resultSchema: z.object({ path: z.string(), content: z.string(), sha256,
      sizeBytes: z.number().int().nonnegative() }),
    capability: "workspace", executor: "computer", authorization: "automatic",
    replayPolicy: "idempotent", receipt: "host",
  },
  workspace_write: {
    description: "在 /workspace 写入 UTF-8 文本，最多 32 KB。新文件直接创建；覆盖已有文件必须先用 workspace_read 获取当前 SHA-256 并传 expectedSha256。",
    inputSchema: z.object({
      path: z.string().min(1).max(240), content: z.string().max(32_000),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }),
    resultSchema: z.object({ path: z.string(), sha256,
      sizeBytes: z.number().int().nonnegative(), created: z.boolean() }),
    capability: "workspace", executor: "computer", authorization: "automatic",
    replayPolicy: "manual_only", receipt: "host",
  },
  publish_report: {
    description: "发布 Markdown 报告为可下载成果。sources 中每个 URL 必须在本任务经 browser_read 实际读取，并在 markdown 正文中原样出现；缺少任一条件会被拒绝。",
    inputSchema: z.object({
      title: z.string().trim().min(1).max(120),
      markdown: z.string().trim().min(100).max(200000),
      sources: z.array(z.url()).min(1).max(30),
    }),
    resultSchema: z.object({ artifactId: z.uuid(), title: z.string(), sha256,
      sources: z.array(httpUrl).optional() }),
    capability: "artifact", executor: "service", authorization: "automatic",
    replayPolicy: "reconcile_before_retry", receipt: "artifact",
  },
  remember: {
    description: "仅在用户明确要求记住一条长期偏好或事实时调用。",
    inputSchema: z.object({
      kind: z.enum(["preference", "fact"]),
      content: z.string().trim().min(1).max(4000),
    }),
    resultSchema: z.object({ memoryId: z.uuid() }),
    capability: "memory", executor: "service", authorization: "automatic",
    replayPolicy: "reconcile_before_retry", receipt: "memory",
  },
  memory_search: {
    description: "查找当前 Bot 已保存的偏好和事实。",
    inputSchema: z.object({ query: z.string().trim().min(1).max(300) }),
    resultSchema: z.object({ memories: z.array(z.object({ id: z.uuid(),
      kind: z.enum(["preference", "fact", "summary"]), content: z.string(),
      revision: z.number().int().positive(), sourceMessageId: z.uuid().nullable(),
      updatedAt: z.iso.datetime() })) }),
    capability: "memory", executor: "service", authorization: "automatic",
    replayPolicy: "idempotent", receipt: "none",
  },
  read_handoff_artifact: {
    description: "分段读取当前子任务明确获授权的上游 Markdown 成果。offset 和 limit 按 Unicode 字符计数，nextOffset 非空时继续读取。",
    inputSchema: z.object({ artifactId: z.uuid(), offset: z.number().int().nonnegative().max(2_000_000).default(0),
      limit: z.number().int().min(1).max(8000).default(8000) }),
    resultSchema: z.object({ artifactId: z.uuid(), title: z.string(), sha256,
      content: z.string(), totalChars: z.number().int().nonnegative(),
      nextOffset: z.number().int().nonnegative().nullable() }),
    capability: "artifact", executor: "service", authorization: "automatic",
    replayPolicy: "idempotent", receipt: "none",
  },
  delegate_to_bot: {
    description: "将明确任务、验收标准和最多 3 个当前任务可访问的 Markdown 成果交给另一 Bot，异步创建受预算限制的子任务。目标 Bot 仅在同时拥有 public_web 与 artifact 能力时可承接 report，否则选择 answer。子任务的报告不替代当前任务所需成果。",
    inputSchema: handoffTaskInput,
    resultSchema: z.object({ childRunId: z.uuid(), conversationId: z.uuid(), targetBotId: z.uuid() }),
    capability: "delegate", executor: "service", authorization: "automatic",
    replayPolicy: "reconcile_before_retry", receipt: "handoff",
  },
  github_issue_create: {
    description: "在已配置的 GitHub 仓库创建 Issue。先起草标题与完整正文，用户逐次批准后才会写入；写入后回读核验。不要在用户只要求解释或草稿时调用。",
    inputSchema: z.object({ title: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(10_000) }),
    resultSchema: z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      number: z.number().int().positive(), url: z.url(), title: z.string(),
      bodySha256: sha256, state: z.enum(["open", "closed"]) }),
    capability: "github_issues", executor: "service", authorization: "per_call_approval",
    replayPolicy: "reconcile_before_retry", receipt: "github_issue",
  },
  shell_exec: {
    description: "在 Linux 电脑的 /workspace 运行一条命令。每次都需要用户看到命令并明确批准；不要用于无需终端的网页研究。",
    inputSchema: z.object({
      command: z.string().trim().min(1).max(2000),
      timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
    }),
    resultSchema: z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable(),
      timedOut: z.boolean(), stoppedByUser: z.boolean().optional(), stdout: z.string(), stderr: z.string(), cwd: z.literal("/workspace"),
      sessionId: z.uuid(), generation: z.number().int().positive(),
      controlEpoch: z.number().int().positive() }),
    capability: "shell", executor: "computer", authorization: "per_call_approval",
    replayPolicy: "manual_only", receipt: "host",
  },
} as const satisfies Record<string, ToolPolicy>;

export type AgentToolName = keyof typeof toolRegistry;
export function verifyToolResult(name: AgentToolName, args: unknown, result: unknown) {
  if (!toolRegistry[name].resultSchema.safeParse(result).success) {
    throw new DomainError(`工具 ${name} 的回执格式无效`, 409, "invalid_tool_result");
  }
  if (name === "workspace_list" || name === "workspace_read" || name === "workspace_write") {
    const path = (args as { path?: string }).path ?? ".";
    const output = result as { path: string; content?: string; sha256?: string; sizeBytes?: number };
    if (output.path !== path) throw new DomainError("工作文件回执路径不匹配", 409, "invalid_tool_result");
    const content = name === "workspace_read" ? output.content :
      name === "workspace_write" ? (args as { content: string }).content : undefined;
    if (content !== undefined) {
      const bytes = Buffer.from(content, "utf8");
      if (output.sizeBytes !== bytes.length ||
        output.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
        throw new DomainError("工作文件回执摘要不匹配", 409, "invalid_tool_result");
      }
    }
  }
  if (name === "github_issue_create") {
    const input = toolRegistry.github_issue_create.inputSchema.parse(args);
    const output = toolRegistry.github_issue_create.resultSchema.parse(result);
    if (output.title !== input.title || output.bodySha256 !== createHash("sha256").update(input.body).digest("hex") ||
      output.url !== `https://github.com/${output.repository}/issues/${output.number}`) {
      throw new DomainError("GitHub Issue 回读与批准内容不一致", 409, "invalid_tool_result");
    }
  }
  return result;
}
export const toolInputSchemas = Object.fromEntries(
  Object.entries(toolRegistry).map(([name, policy]) => [name, policy.inputSchema]),
) as { [Name in AgentToolName]: typeof toolRegistry[Name]["inputSchema"] };
export const agentTools = {
  browser_open: tool({ description: toolRegistry.browser_open.description,
    inputSchema: toolRegistry.browser_open.inputSchema }),
  browser_read: tool({ description: toolRegistry.browser_read.description,
    inputSchema: toolRegistry.browser_read.inputSchema }),
  browser_screenshot: tool({ description: toolRegistry.browser_screenshot.description,
    inputSchema: toolRegistry.browser_screenshot.inputSchema }),
  browser_click: tool({ description: toolRegistry.browser_click.description,
    inputSchema: toolRegistry.browser_click.inputSchema }),
  browser_fill: tool({ description: toolRegistry.browser_fill.description,
    inputSchema: toolRegistry.browser_fill.inputSchema }),
  desktop_observe: tool({ description: toolRegistry.desktop_observe.description,
    inputSchema: toolRegistry.desktop_observe.inputSchema }),
  desktop_click: tool({ description: toolRegistry.desktop_click.description,
    inputSchema: toolRegistry.desktop_click.inputSchema }),
  desktop_key: tool({ description: toolRegistry.desktop_key.description,
    inputSchema: toolRegistry.desktop_key.inputSchema }),
  desktop_type: tool({ description: toolRegistry.desktop_type.description,
    inputSchema: toolRegistry.desktop_type.inputSchema }),
  workspace_list: tool({ description: toolRegistry.workspace_list.description,
    inputSchema: toolRegistry.workspace_list.inputSchema }),
  workspace_read: tool({ description: toolRegistry.workspace_read.description,
    inputSchema: toolRegistry.workspace_read.inputSchema }),
  workspace_write: tool({ description: toolRegistry.workspace_write.description,
    inputSchema: toolRegistry.workspace_write.inputSchema }),
  publish_report: tool({ description: toolRegistry.publish_report.description,
    inputSchema: toolRegistry.publish_report.inputSchema }),
  remember: tool({ description: toolRegistry.remember.description,
    inputSchema: toolRegistry.remember.inputSchema }),
  memory_search: tool({ description: toolRegistry.memory_search.description,
    inputSchema: toolRegistry.memory_search.inputSchema }),
  read_handoff_artifact: tool({ description: toolRegistry.read_handoff_artifact.description,
    inputSchema: toolRegistry.read_handoff_artifact.inputSchema }),
  delegate_to_bot: tool({ description: toolRegistry.delegate_to_bot.description,
    inputSchema: toolRegistry.delegate_to_bot.inputSchema }),
  github_issue_create: tool({ description: toolRegistry.github_issue_create.description,
    inputSchema: toolRegistry.github_issue_create.inputSchema }),
  shell_exec: tool({ description: toolRegistry.shell_exec.description,
    inputSchema: toolRegistry.shell_exec.inputSchema }),
} satisfies Record<AgentToolName, unknown>;
export function toolsForCapabilities(capabilities: readonly ToolCapability[]) {
  const enabled = new Set(capabilities);
  return Object.fromEntries((Object.keys(agentTools) as AgentToolName[])
    .filter(name => enabled.has(toolRegistry[name].capability))
    .map(name => [name, agentTools[name]])) as typeof agentTools;
}
export const agentToolNames = new Set<AgentToolName>(Object.keys(toolRegistry) as AgentToolName[]);
export const computerToolNames = Object.keys(toolRegistry).filter(name =>
  toolRegistry[name as AgentToolName].executor === "computer") as AgentToolName[];
export const approvalRequiredTools = new Set<AgentToolName>(
  (Object.keys(toolRegistry) as AgentToolName[]).filter(name =>
    toolRegistry[name].authorization === "per_call_approval"),
);
export function isComputerTool(name: AgentToolName): boolean {
  return toolRegistry[name].executor === "computer";
}

export function validateModelConnection(input: {
  provider: ModelProfile["provider"]; baseUrl?: string | null; apiKey?: string | null;
}) {
  if (input.provider === "openai-compatible" && !input.baseUrl) {
    throw new DomainError("请填写模型 API 地址");
  }
  if (input.provider === "anthropic" && !input.apiKey) {
    throw new DomainError("Anthropic 协议需要 API Key", 422, "api_key_required");
  }
  if (input.baseUrl) {
    const url = new URL(input.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new DomainError("模型 API 地址需要 HTTPS；本机服务可使用 HTTP");
    }
  }
}

export function providerModel(profile: Pick<ModelConfiguration, "provider" | "modelId" | "baseUrl" | "apiKey">) {
  if (profile.provider === "anthropic") {
    if (!profile.apiKey) throw new Error("Anthropic 配置缺少 API Key");
    return createAnthropic({ apiKey: profile.apiKey,
      ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}) })(profile.modelId);
  }
  if (!profile.baseUrl) throw new Error("模型配置缺少 API 地址");
  const provider = createOpenAICompatible({
    name: "configured",
    baseURL: profile.baseUrl,
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
  });
  return provider.chatModel(profile.modelId);
}

export async function generateAgentStep(profile: ModelConfiguration, input: {
  system: string; messages: ModelMessage[]; signal: AbortSignal;
  capabilities: ToolCapability[];
  maxOutputTokens: number; maxCallMs: number;
  onPartial?: (text: string) => Promise<void>;
}) {
  const timeout = AbortSignal.timeout(input.maxCallMs);
  const options = {
    model: providerModel(profile),
    system: input.system,
    messages: input.messages,
    tools: toolsForCapabilities(profile.capabilities.tools
      ? input.capabilities.filter(capability => capability !== "desktop" || profile.capabilities.vision)
      : []),
    maxOutputTokens: input.maxOutputTokens,
    abortSignal: AbortSignal.any([input.signal, timeout]),
  };
  if (!profile.capabilities.streaming) {
    try {
      const result = await generateText(options);
      return {
        text: result.text,
        toolCalls: result.toolCalls.map(call => ({
          toolCallId: call.toolCallId, toolName: call.toolName, input: call.input,
        })),
        responseMessages: result.responseMessages as ModelMessage[],
        usage: result.usage,
      };
    } catch (error) {
      if (timeout.aborted && !input.signal.aborted) throw new Error("模型调用超过时限");
      throw error;
    }
  }
  const result = streamText(options);
  let partial = "";
  let lastSaved = 0;
  try {
    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        partial += part.text;
        if (input.onPartial && Date.now() - lastSaved >= 1000) {
          await input.onPartial(partial);
          lastSaved = Date.now();
        }
      } else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      } else if (part.type === "abort") {
        throw new Error("模型流已中断");
      }
    }
  } catch (error) {
    if (partial && input.onPartial) await input.onPartial(partial).catch(() => undefined);
    if (timeout.aborted && !input.signal.aborted) throw new Error("模型调用超过时限");
    throw error;
  }
  return {
    text: await result.text,
    toolCalls: (await result.toolCalls).map(call => ({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    })),
    responseMessages: await result.responseMessages as ModelMessage[],
    usage: await result.usage,
  };
}
