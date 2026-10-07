import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Skill, SkillDefinition, SkillVersion, ToolCapability } from "@opengrok/contracts";
import { query, transaction } from "./db.js";
import { DomainError } from "./errors.js";
import { toolRegistry, type AgentToolName } from "./model.js";

type VersionRow = {
  skill_id: string; version: number; name: string; summary: string;
  input_guide: string; steps: string[]; verification: string;
  required_capabilities: ToolCapability[]; source_run_id: string | null;
  created_at: Date;
};
type SkillRow = VersionRow & { updated_at: Date; bound_bot_ids: string[] };

function version(row: VersionRow): SkillVersion {
  return {
    skillId: row.skill_id, version: row.version, name: row.name,
    summary: row.summary, inputGuide: row.input_guide, steps: row.steps,
    verification: row.verification, requiredCapabilities: row.required_capabilities,
    sourceRunId: row.source_run_id, createdAt: row.created_at.toISOString(),
  };
}

function skill(row: SkillRow): Skill {
  return { ...version(row), boundBotIds: row.bound_bot_ids,
    updatedAt: row.updated_at.toISOString() };
}

async function assertSourceRun(client: PoolClient, ownerId: string, runId: string | null | undefined) {
  if (!runId) return;
  const source = await client.query<{ status: string }>(
    "SELECT status FROM runs WHERE id=$1 AND owner_id=$2", [runId, ownerId],
  );
  if (source.rows[0]?.status !== "succeeded") {
    throw new DomainError("技能来源必须是自己的已完成任务", 422, "skill_source_invalid");
  }
}

async function insertVersion(client: PoolClient, skillId: string, number: number,
  input: SkillDefinition, sourceRunId: string | null) {
  await client.query(
    `INSERT INTO skill_versions(skill_id,version,name,summary,input_guide,steps,verification,
      required_capabilities,source_run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [skillId, number, input.name, input.summary, input.inputGuide,
      JSON.stringify(input.steps), input.verification,
      JSON.stringify(input.requiredCapabilities), sourceRunId],
  );
}

export async function listSkills(ownerId: string): Promise<Skill[]> {
  const result = await query<SkillRow>(
    `SELECT v.*,s.updated_at,COALESCE((SELECT array_agg(bs.bot_id ORDER BY bs.bot_id)
       FROM bot_skills bs WHERE bs.skill_id=s.id),ARRAY[]::uuid[]) AS bound_bot_ids
     FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.current_version
     WHERE s.owner_id=$1 ORDER BY s.updated_at DESC,s.id`, [ownerId],
  );
  return result.rows.map(skill);
}

export async function getSkill(ownerId: string, skillId: string): Promise<Skill> {
  const result = await query<SkillRow>(
    `SELECT v.*,s.updated_at,COALESCE((SELECT array_agg(bs.bot_id ORDER BY bs.bot_id)
       FROM bot_skills bs WHERE bs.skill_id=s.id),ARRAY[]::uuid[]) AS bound_bot_ids
     FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.current_version
     WHERE s.owner_id=$1 AND s.id=$2`, [ownerId, skillId],
  );
  if (!result.rows[0]) throw new DomainError("找不到技能", 404, "skill_not_found");
  return skill(result.rows[0]);
}

export async function listSkillVersions(ownerId: string, skillId: string): Promise<SkillVersion[]> {
  await getSkill(ownerId, skillId);
  const result = await query<VersionRow>(
    "SELECT * FROM skill_versions WHERE skill_id=$1 ORDER BY version DESC", [skillId],
  );
  return result.rows.map(version);
}

export async function createSkill(ownerId: string, input: SkillDefinition): Promise<Skill> {
  const id = randomUUID();
  await transaction(async client => {
    await assertSourceRun(client, ownerId, input.sourceRunId);
    await client.query("INSERT INTO skills(id,owner_id) VALUES ($1,$2)", [id, ownerId]);
    await insertVersion(client, id, 1, input, input.sourceRunId || null);
  });
  return getSkill(ownerId, id);
}

export async function updateSkill(ownerId: string, skillId: string, expectedVersion: number,
  input: SkillDefinition): Promise<Skill> {
  await transaction(async client => {
    const current = await client.query<{ current_version: number; source_run_id: string | null }>(
      `SELECT s.current_version,v.source_run_id FROM skills s
       JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.current_version
       WHERE s.owner_id=$1 AND s.id=$2 FOR UPDATE OF s`, [ownerId, skillId],
    );
    if (!current.rows[0]) throw new DomainError("找不到技能", 404, "skill_not_found");
    if (current.rows[0].current_version !== expectedVersion) {
      throw new DomainError("技能已更新，请刷新后重试", 409, "skill_version_conflict");
    }
    const sourceRunId = input.sourceRunId === undefined
      ? current.rows[0].source_run_id : input.sourceRunId;
    await assertSourceRun(client, ownerId, sourceRunId);
    await insertVersion(client, skillId, expectedVersion + 1, input, sourceRunId || null);
    await client.query("UPDATE skills SET current_version=$2,updated_at=now() WHERE id=$1",
      [skillId, expectedVersion + 1]);
  });
  return getSkill(ownerId, skillId);
}

export async function bindSkill(ownerId: string, botId: string, skillId: string): Promise<Skill> {
  await transaction(async client => {
    const bot = await client.query("SELECT id FROM bots WHERE owner_id=$1 AND id=$2 FOR UPDATE",
      [ownerId, botId]);
    if (!bot.rowCount) throw new DomainError("找不到 Bot", 404, "bot_not_found");
    const found = await client.query("SELECT id FROM skills WHERE owner_id=$1 AND id=$2",
      [ownerId, skillId]);
    if (!found.rowCount) throw new DomainError("找不到技能", 404, "skill_not_found");
    const bound = await client.query("SELECT skill_id FROM bot_skills WHERE bot_id=$1", [botId]);
    if (bound.rows.some(row => row.skill_id === skillId)) return;
    if (bound.rows.length >= 3) throw new DomainError("每个 Bot 最多绑定 3 个技能", 422, "skill_limit");
    await client.query("INSERT INTO bot_skills(bot_id,skill_id) VALUES ($1,$2)", [botId, skillId]);
  });
  return getSkill(ownerId, skillId);
}

export async function unbindSkill(ownerId: string, botId: string, skillId: string): Promise<void> {
  await transaction(async client => {
    const bot = await client.query("SELECT id FROM bots WHERE owner_id=$1 AND id=$2", [ownerId, botId]);
    if (!bot.rowCount) throw new DomainError("找不到 Bot", 404, "bot_not_found");
    await client.query("DELETE FROM bot_skills WHERE bot_id=$1 AND skill_id=$2", [botId, skillId]);
  });
}

export async function snapshotBoundSkills(client: PoolClient, runId: string, botId: string,
  selected?: { skillId: string; version: number } | null) {
  if (selected) {
    await client.query(
      "INSERT INTO run_skill_versions(run_id,skill_id,version) VALUES ($1,$2,$3)",
      [runId, selected.skillId, selected.version],
    );
    return;
  }
  await client.query(
    `INSERT INTO run_skill_versions(run_id,skill_id,version)
     SELECT $1,s.id,s.current_version FROM bot_skills bs
     JOIN skills s ON s.id=bs.skill_id WHERE bs.bot_id=$2`, [runId, botId],
  );
}

export async function listRunSkillVersions(ownerId: string, runId: string): Promise<SkillVersion[]> {
  const result = await query<VersionRow>(
    `SELECT v.* FROM runs r JOIN run_skill_versions rs ON rs.run_id=r.id
     JOIN skill_versions v ON v.skill_id=rs.skill_id AND v.version=rs.version
     WHERE r.owner_id=$1 AND r.id=$2 ORDER BY v.name,v.skill_id`, [ownerId, runId],
  );
  return result.rows.map(version);
}

export async function skillDraftFromRun(ownerId: string, runId: string): Promise<SkillDefinition> {
  const run = await query<{ status: string }>("SELECT status FROM runs WHERE owner_id=$1 AND id=$2",
    [ownerId, runId]);
  if (run.rows[0]?.status !== "succeeded") {
    throw new DomainError("只有已完成任务可作为技能来源", 422, "skill_source_invalid");
  }
  const calls = await query<{ name: AgentToolName }>(
    `SELECT c.name FROM tool_calls c WHERE c.run_id=$1 AND c.status='succeeded'
     ORDER BY c.created_at,c.id LIMIT 30`, [runId],
  );
  const names = [...new Set(calls.rows.map(row => row.name))];
  const capabilities = [...new Set(names.map(name => toolRegistry[name].capability))];
  return {
    name: `任务 ${runId.slice(0, 8)}`, summary: "",
    inputGuide: "写明目标、范围、输入资料和期望产物。",
    steps: names.length ? names.slice(0, 8).map(name =>
      `${name}: ${toolRegistry[name].description}`.slice(0, 300)) : ["根据输入完成任务并核对结果。"],
    verification: names.includes("publish_report")
      ? "确认报告成果可打开，结论有实际读取的来源支持。" : "回读实际结果，确认满足任务要求。",
    requiredCapabilities: capabilities, sourceRunId: runId,
  };
}

export function skillPrompt(versions: SkillVersion[], capabilities: ToolCapability[]): string {
  if (!versions.length) return "";
  const available = versions.filter(item => item.requiredCapabilities.every(capability =>
    capabilities.includes(capability)));
  const unavailable = versions.filter(item => !available.includes(item));
  return [
    "以下为用户保存的技能，只在当前任务适用时参考；当前用户消息优先。技能不会授予工具权限，所有操作仍受 Bot 授权与逐次审批约束。",
    ...available.map(item => [
      `技能：${item.name} (v${item.version})`, item.summary,
      `输入：${item.inputGuide}`,
      ...item.steps.map((step, index) => `${index + 1}. ${step}`),
      `结果核验：${item.verification}`,
    ].filter(Boolean).join("\n")),
    unavailable.length ? `当前权限不足，不能使用：${unavailable.map(item => item.name).join("、")}` : "",
  ].filter(Boolean).join("\n\n");
}
