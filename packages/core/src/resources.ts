import { randomUUID } from "node:crypto";
import { resolveArtifactPath } from "./artifact-path.js";
import { defaultToolCapabilities, type Artifact, type Bot, type Conversation, type Memory,
  type ModelProfile, type ToolCapability } from "@opengrok/contracts";
import { query, transaction } from "./db.js";
import { DomainError } from "./errors.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { toolRegistry, type AgentToolName } from "./model.js";
import { addEvent } from "./runs.js";

type BotRow = {
  id: string; name: string; description: string; instructions: string;
  model_profile_id: string | null; revision: number;
  capabilities_json: ToolCapability[];
  created_at: Date; updated_at: Date;
};
type ConversationRow = {
  id: string; bot_id: string; title: string; created_at: Date; updated_at: Date;
};
type MemoryRow = {
  id: string; bot_id: string; kind: Memory["kind"]; content: string;
  revision: number; source_message_id: string | null; created_at: Date; updated_at: Date;
};
type ProfileRow = {
  id: string; name: string; provider: ModelProfile["provider"];
  model_id: string; base_url: string | null; encrypted_api_key: string | null;
  capabilities_json: ModelProfile["capabilities"];
  created_at: Date;
};
type ArtifactRow = {
  id: string; run_id: string; title: string; mime_type: string;
  sha256: string; size_bytes: string; storage_path: string;
  source_refs: string[]; created_at: Date;
};

function bot(row: BotRow): Bot {
  return {
    id: row.id, name: row.name, description: row.description,
    instructions: row.instructions, modelProfileId: row.model_profile_id,
    capabilities: row.capabilities_json,
    revision: row.revision, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function conversation(row: ConversationRow): Conversation {
  return {
    id: row.id, botId: row.bot_id, title: row.title,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function memory(row: MemoryRow): Memory {
  return {
    id: row.id, botId: row.bot_id, kind: row.kind, content: row.content,
    revision: row.revision, sourceMessageId: row.source_message_id,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function profile(row: ProfileRow): ModelProfile {
  return {
    id: row.id, name: row.name, provider: row.provider, modelId: row.model_id,
    baseUrl: row.base_url, hasApiKey: Boolean(row.encrypted_api_key),
    capabilities: row.capabilities_json,
    createdAt: row.created_at.toISOString(),
  };
}

function artifact(row: ArtifactRow): Artifact {
  return {
    id: row.id, runId: row.run_id, title: row.title, mimeType: row.mime_type,
    sha256: row.sha256, size: Number(row.size_bytes), sources: row.source_refs,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listBots(ownerId: string): Promise<Bot[]> {
  const result = await query<BotRow>("SELECT * FROM bots WHERE owner_id=$1 ORDER BY updated_at DESC", [ownerId]);
  return result.rows.map(bot);
}

export async function getBot(ownerId: string, botId: string): Promise<Bot> {
  const result = await query<BotRow>("SELECT * FROM bots WHERE owner_id=$1 AND id=$2", [ownerId, botId]);
  if (!result.rows[0]) throw new DomainError("找不到 Bot", 404, "bot_not_found");
  return bot(result.rows[0]);
}

export async function createBot(ownerId: string, input: {
  name: string; description: string; instructions: string; modelProfileId?: string | null;
  capabilities?: ToolCapability[];
}): Promise<Bot> {
  if (input.modelProfileId) await getModelProfile(ownerId, input.modelProfileId);
  const id = randomUUID();
  await transaction(async client => {
    await client.query(
      `INSERT INTO bots(id,owner_id,name,description,instructions,model_profile_id,capabilities_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, ownerId, input.name, input.description, input.instructions, input.modelProfileId || null,
        JSON.stringify(input.capabilities ?? defaultToolCapabilities)],
    );
    await client.query("INSERT INTO bot_execution_slots(bot_id) VALUES ($1)", [id]);
  });
  return getBot(ownerId, id);
}

export async function updateBot(ownerId: string, botId: string, input: {
  name?: string; description?: string; instructions?: string;
  modelProfileId?: string | null; capabilities?: ToolCapability[]; expectedRevision: number;
}): Promise<Bot> {
  if (input.modelProfileId) await getModelProfile(ownerId, input.modelProfileId);
  return transaction(async client => {
    const waiting = input.capabilities === undefined ? [] : (await client.query<{ id: string }>(
      `SELECT id FROM runs WHERE bot_id=$1 AND owner_id=$2 AND status='waiting_approval'
       ORDER BY id FOR UPDATE`, [botId, ownerId],
    )).rows;
    const result = await client.query<BotRow>(
      `UPDATE bots SET name=COALESCE($4,name), description=COALESCE($5,description),
         instructions=COALESCE($6,instructions),
         model_profile_id=CASE WHEN $7::boolean THEN $8::uuid ELSE model_profile_id END,
         capabilities_json=COALESCE($9::jsonb,capabilities_json),
         revision=revision+1, updated_at=now()
       WHERE owner_id=$1 AND id=$2 AND revision=$3 RETURNING *`,
      [ownerId, botId, input.expectedRevision, input.name ?? null,
        input.description ?? null, input.instructions ?? null,
        Object.hasOwn(input, "modelProfileId"), input.modelProfileId ?? null,
        input.capabilities === undefined ? null : JSON.stringify(input.capabilities)],
    );
    if (!result.rows[0]) {
      const exists = await client.query("SELECT 1 FROM bots WHERE owner_id=$1 AND id=$2", [ownerId, botId]);
      if (!exists.rowCount) throw new DomainError("找不到 Bot", 404, "bot_not_found");
      throw new DomainError("Bot 已被其他操作修改，请刷新", 409, "revision_conflict");
    }
    for (const run of waiting) {
      const pending = await client.query<{ name: AgentToolName }>(
        `SELECT c.name FROM approvals a JOIN tool_calls c ON c.id=a.call_id
         WHERE a.run_id=$1 AND a.status='pending'`, [run.id],
      );
      if (!pending.rows.some(item => !result.rows[0].capabilities_json.includes(
        toolRegistry[item.name].capability))) continue;
      await client.query(
        `UPDATE approvals SET status='expired',decided_at=now()
         WHERE run_id=$1 AND status='pending'`, [run.id],
      );
      await client.query(
        `UPDATE tool_calls SET status='failed',result=$2,updated_at=now()
         WHERE run_id=$1 AND status IN ('proposed','authorized','waiting_approval')`,
        [run.id, JSON.stringify({ error: "Bot 能力已变更，旧审批失效，工具未执行" })],
      );
      await client.query(
        `UPDATE runs SET status='failed',error='Bot 能力已变更，待审批工具未执行',
         lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [run.id],
      );
      await client.query(
        "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1",
        [run.id],
      );
      await addEvent(client, run.id, "failed", { reason: "bot_capability_changed" });
    }
    return bot(result.rows[0]);
  });
}

export async function listConversations(ownerId: string, botId: string): Promise<Conversation[]> {
  await getBot(ownerId, botId);
  const result = await query<ConversationRow>(
    "SELECT * FROM conversations WHERE owner_id=$1 AND bot_id=$2 ORDER BY updated_at DESC",
    [ownerId, botId],
  );
  return result.rows.map(conversation);
}

export async function getConversation(ownerId: string, conversationId: string): Promise<Conversation> {
  const result = await query<ConversationRow>(
    "SELECT * FROM conversations WHERE owner_id=$1 AND id=$2", [ownerId, conversationId],
  );
  if (!result.rows[0]) throw new DomainError("找不到对话", 404, "conversation_not_found");
  return conversation(result.rows[0]);
}

export async function createConversation(ownerId: string, botId: string): Promise<Conversation> {
  await getBot(ownerId, botId);
  const id = randomUUID();
  await query("INSERT INTO conversations(id,owner_id,bot_id) VALUES ($1,$2,$3)", [id, ownerId, botId]);
  return getConversation(ownerId, id);
}

export async function listModelProfiles(ownerId: string): Promise<ModelProfile[]> {
  const result = await query<ProfileRow>(
    "SELECT * FROM model_profiles WHERE owner_id=$1 ORDER BY created_at DESC", [ownerId],
  );
  return result.rows.map(profile);
}

export async function getModelProfile(ownerId: string, profileId: string) {
  const result = await query<ProfileRow>(
    "SELECT * FROM model_profiles WHERE owner_id=$1 AND id=$2", [ownerId, profileId],
  );
  if (!result.rows[0]) throw new DomainError("找不到模型配置", 404, "profile_not_found");
  const row = result.rows[0];
  return { ...profile(row), apiKey: row.encrypted_api_key ? decryptSecret(row.encrypted_api_key) : null };
}

export async function createModelProfile(ownerId: string, input: {
  name: string; provider: ModelProfile["provider"]; modelId: string;
  baseUrl?: string | null; apiKey?: string;
  capabilities?: ModelProfile["capabilities"];
}): Promise<ModelProfile> {
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
  const id = randomUUID();
  await query(
    `INSERT INTO model_profiles(id,owner_id,name,provider,model_id,base_url,encrypted_api_key,capabilities_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, ownerId, input.name, input.provider, input.modelId, input.baseUrl || null,
      input.apiKey ? encryptSecret(input.apiKey) : null,
      JSON.stringify(input.capabilities ?? { text: true, tools: true, vision: false, streaming: true })],
  );
  const result = await query<ProfileRow>("SELECT * FROM model_profiles WHERE id=$1", [id]);
  return profile(result.rows[0]);
}

export async function listMemories(ownerId: string, botId: string): Promise<Memory[]> {
  await getBot(ownerId, botId);
  const result = await query<MemoryRow>(
    `SELECT * FROM memory_entries WHERE owner_id=$1 AND bot_id=$2 AND status='accepted'
     ORDER BY updated_at DESC`, [ownerId, botId],
  );
  return result.rows.map(memory);
}

export async function putMemory(ownerId: string, botId: string, input: {
  kind: "preference" | "fact"; content: string; memoryId?: string;
  expectedRevision?: number; sourceMessageId?: string | null;
}): Promise<Memory> {
  await getBot(ownerId, botId);
  if (input.memoryId) {
    if (!input.expectedRevision) throw new DomainError("修改记忆需要当前版本");
    const result = await query<MemoryRow>(
      `UPDATE memory_entries SET kind=$4,content=$5,revision=revision+1,updated_at=now()
       WHERE owner_id=$1 AND bot_id=$2 AND id=$3 AND revision=$6 AND status='accepted'
       RETURNING *`,
      [ownerId, botId, input.memoryId, input.kind, input.content, input.expectedRevision],
    );
    if (!result.rows[0]) throw new DomainError("记忆已被修改或删除，请刷新", 409, "revision_conflict");
    return memory(result.rows[0]);
  }
  if (input.sourceMessageId) {
    const source = await query(
      "SELECT 1 FROM messages WHERE id=$1 AND owner_id=$2", [input.sourceMessageId, ownerId],
    );
    if (!source.rowCount) throw new DomainError("记忆来源不属于当前用户", 403, "invalid_source");
  }
  const id = randomUUID();
  const result = await query<MemoryRow>(
    `INSERT INTO memory_entries(id,owner_id,bot_id,kind,content,status,source_message_id)
     VALUES ($1,$2,$3,$4,$5,'accepted',$6) RETURNING *`,
    [id, ownerId, botId, input.kind, input.content, input.sourceMessageId || null],
  );
  return memory(result.rows[0]);
}

export async function deleteMemory(ownerId: string, botId: string, memoryId: string, expectedRevision: number) {
  const result = await query<MemoryRow>(
    `UPDATE memory_entries SET status='deleted',revision=revision+1,updated_at=now()
     WHERE owner_id=$1 AND bot_id=$2 AND id=$3 AND revision=$4 AND status='accepted' RETURNING *`,
    [ownerId, botId, memoryId, expectedRevision],
  );
  if (!result.rows[0]) throw new DomainError("记忆已被修改或删除，请刷新", 409, "revision_conflict");
  return memory(result.rows[0]);
}

export async function listArtifacts(ownerId: string, runId: string): Promise<Artifact[]> {
  const result = await query<ArtifactRow>(
    "SELECT * FROM artifacts WHERE owner_id=$1 AND run_id=$2 ORDER BY created_at DESC", [ownerId, runId],
  );
  return result.rows.map(artifact);
}

export async function getArtifact(ownerId: string, artifactId: string) {
  const result = await query<ArtifactRow>(
    "SELECT * FROM artifacts WHERE owner_id=$1 AND id=$2", [ownerId, artifactId],
  );
  if (!result.rows[0]) throw new DomainError("找不到成果", 404, "artifact_not_found");
  return { ...artifact(result.rows[0]), storagePath: resolveArtifactPath(result.rows[0].storage_path) };
}
