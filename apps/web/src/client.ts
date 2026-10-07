import type {
  Artifact, Bot, Conversation, Memory, Message, ModelProfile, Run, RunEvent,
} from "@opengrok/contracts";

type ApiError = Error & { code?: string; status?: number };

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败 (${response.status})`) as ApiError;
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data as T;
}

export function json(method: "POST" | "PATCH" | "DELETE", body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

export type ListResponse<T, K extends string> = Record<K, T[]>;
export type BotResponse = { bot: Bot };
export type ConversationResponse = { conversation: Conversation };
export type SubmitResponse = { run: Run; message: Message };
export type RunResponse = { run: Run };
export type MemoryResponse = { memory: Memory };
export type ArtifactResponse = { artifact: Artifact };
export type ProfileResponse = { profile: ModelProfile };
export type EventResponse = { event: RunEvent };
