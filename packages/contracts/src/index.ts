import { z } from "zod";

export const toolCapabilitySchema = z.enum(["public_web", "workspace", "artifact", "memory", "shell", "desktop", "delegate", "github_issues"]);
export type ToolCapability = z.infer<typeof toolCapabilitySchema>;
export const defaultToolCapabilities: ToolCapability[] = ["public_web", "workspace", "artifact", "memory"];

export const botInput = z.object({
  name: z.string().trim().min(1).max(48),
  description: z.string().trim().max(300).default(""),
  instructions: z.string().trim().max(8000).default(""),
  modelProfileId: z.string().uuid().nullable().optional(),
  capabilities: z.array(toolCapabilitySchema).max(toolCapabilitySchema.options.length)
    .refine(value => new Set(value).size === value.length, "能力不能重复")
    .default(defaultToolCapabilities),
});

export const messageInput = z.object({
  text: z.string().trim().min(1).max(20000),
  requestId: z.string().uuid(),
  deliverable: z.enum(["answer", "report"]).default("answer"),
});

export const memoryInput = z.object({
  kind: z.enum(["preference", "fact"]),
  content: z.string().trim().min(1).max(4000),
  expectedRevision: z.number().int().positive().optional(),
});

export const skillDefinitionInput = z.object({
  name: z.string().trim().min(1).max(64),
  summary: z.string().trim().max(300).default(""),
  inputGuide: z.string().trim().min(1).max(1000),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  verification: z.string().trim().min(1).max(1000),
  requiredCapabilities: z.array(toolCapabilitySchema).max(toolCapabilitySchema.options.length)
    .refine(value => new Set(value).size === value.length, "能力不能重复"),
  sourceRunId: z.string().uuid().nullable().optional(),
});

export type SkillDefinition = z.infer<typeof skillDefinitionInput>;

export type SkillVersion = {
  skillId: string;
  version: number;
  name: string;
  summary: string;
  inputGuide: string;
  steps: string[];
  verification: string;
  requiredCapabilities: ToolCapability[];
  sourceRunId: string | null;
  createdAt: string;
};

export type Skill = SkillVersion & {
  boundBotIds: string[];
  updatedAt: string;
};

export const routineInput = z.object({
  botId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  timeZone: z.string().trim().min(1).max(100),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  inputText: z.string().trim().min(1).max(20000),
  deliverable: z.enum(["answer", "report"]),
  budget: z.lazy(() => runBudgetSchema),
  skillId: z.string().uuid().nullable(),
});
export type RoutineInput = z.infer<typeof routineInput>;

export type Routine = RoutineInput & {
  id: string;
  skillVersion: number | null;
  status: "active" | "paused";
  nextFireAt: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type RoutineOccurrence = {
  id: string;
  routineId: string;
  scheduledAt: string;
  trigger: "scheduled" | "manual";
  status: "pending" | "submitted" | "failed";
  runId: string | null;
  conversationId: string;
  runStatus: RunStatus | null;
  error: string | null;
  createdAt: string;
};

export const handoffTaskInput = z.object({
  targetBotId: z.uuid(),
  task: z.string().trim().min(1).max(4000),
  acceptance: z.string().trim().min(1).max(2000),
  deliverable: z.enum(["answer", "report"]),
  artifactIds: z.array(z.uuid()).max(3).refine(ids => new Set(ids).size === ids.length,
    "成果引用不能重复").default([]),
});
export const handoffRequestInput = handoffTaskInput.extend({ requestId: z.uuid() });
export type HandoffTaskInput = z.infer<typeof handoffTaskInput>;

export type HandoffLink = {
  id: string;
  botId: string;
  botName: string;
  conversationId: string;
  status: RunStatus;
  task: string;
  acceptance: string;
  artifactIds: string[];
  depth: number;
  createdAt: string;
};

export const modelProfileInput = z.object({
  name: z.string().trim().min(1).max(80),
  provider: z.enum(["openai-compatible", "anthropic"]),
  modelId: z.string().trim().min(1).max(160),
  baseUrl: z.url().nullable().optional(),
  apiKey: z.string().max(1000).optional(),
  capabilities: z.object({
    text: z.literal(true),
    tools: z.boolean(),
    vision: z.boolean(),
    streaming: z.boolean(),
  }).default({ text: true, tools: true, vision: false, streaming: true }),
});

export const runBudgetSchema = z.object({
  maxModelSteps: z.number().int().min(1).max(100),
  maxToolCalls: z.number().int().min(1).max(500),
  maxTokens: z.number().int().min(1).max(1_000_000),
  maxWallMs: z.number().int().min(1_000).max(7 * 24 * 60 * 60_000),
  maxModelCallMs: z.number().int().min(1_000).max(10 * 60_000),
  maxModelOutputTokens: z.number().int().min(16).max(8192),
  maxArtifactBytes: z.number().int().min(100).max(2_000_000),
});
export type RunBudget = z.infer<typeof runBudgetSchema>;

export type RunStatus =
  | "queued" | "running" | "waiting_approval" | "waiting_user"
  | "waiting_computer" | "reconciling" | "verifying" | "canceling"
  | "succeeded" | "failed" | "canceled";

export type Bot = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  modelProfileId: string | null;
  capabilities: ToolCapability[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type Conversation = {
  id: string;
  botId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  conversationId: string;
  runId: string | null;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type Run = {
  id: string;
  botId: string;
  conversationId: string;
  parentRunId: string | null;
  rootRunId: string | null;
  delegationDepth: number;
  status: RunStatus;
  inputRevision: number;
  consumedInputSequence: number;
  expectedArtifact: boolean;
  budget: RunBudget;
  tokenCount: number;
  tokenUsageEstimated: boolean;
  toolCount: number;
  resultText: string | null;
  error: string | null;
  unresolvedEffects: Array<{ operationId: string; name?: string; evidence: unknown[] }>;
  createdAt: string;
  updatedAt: string;
};

export type RunEvent = {
  runId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ShellCommand = {
  operationId: string;
  command: string;
  timeoutMs: number;
  status: "proposed" | "waiting_approval" | "authorized" | "dispatching" |
    "succeeded" | "failed" | "unknown";
  stopRequestedAt: string | null;
  result: { exitCode?: number | null; signal?: string | null; timedOut?: boolean;
    stoppedByUser?: boolean; stdout?: string; stderr?: string; error?: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type Memory = {
  id: string;
  botId: string;
  kind: "preference" | "fact" | "summary";
  content: string;
  revision: number;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Artifact = {
  id: string;
  runId: string;
  title: string;
  mimeType: string;
  sha256: string;
  size: number;
  sources: string[];
  createdAt: string;
};

export type ModelProfile = {
  id: string;
  name: string;
  provider: "openai-compatible" | "anthropic";
  modelId: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  capabilities: z.infer<typeof modelProfileInput>["capabilities"];
  createdAt: string;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("Only JSON values can be canonicalized");
}
