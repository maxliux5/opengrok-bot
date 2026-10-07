import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { Routine, RoutineInput, RoutineOccurrence, RunBudget, RunStatus,
  ToolCapability } from "@opengrok/contracts";
import { query, transaction } from "./db.js";
import { DomainError } from "./errors.js";
import { addEvent, submitMessage } from "./runs.js";

type RoutineRow = {
  id: string; owner_id: string; bot_id: string; name: string;
  time_zone: string; local_time: string; input_text: string;
  deliverable: "answer" | "report"; budget_json: RunBudget;
  skill_id: string | null; skill_version: number | null;
  status: "active" | "paused"; next_fire_at: Date;
  revision: number; created_at: Date; updated_at: Date;
};
type OccurrenceRow = {
  id: string; owner_id: string; routine_id: string; bot_id: string; routine_name: string;
  scheduled_at: Date;
  trigger: "scheduled" | "manual"; request_id: string; conversation_id: string;
  run_id: string | null; status: "pending" | "submitted" | "failed";
  input_text: string; deliverable: "answer" | "report"; budget_json: RunBudget;
  skill_id: string | null; skill_version: number | null;
  error: string | null; created_at: Date; run_status: RunStatus | null;
  run_error: string | null;
};

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id, botId: row.bot_id, name: row.name, timeZone: row.time_zone,
    localTime: row.local_time, inputText: row.input_text, deliverable: row.deliverable,
    budget: row.budget_json, skillId: row.skill_id, skillVersion: row.skill_version,
    status: row.status, nextFireAt: row.next_fire_at.toISOString(), revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function toOccurrence(row: OccurrenceRow): RoutineOccurrence {
  return {
    id: row.id, routineId: row.routine_id, scheduledAt: row.scheduled_at.toISOString(),
    trigger: row.trigger, status: row.status, runId: row.run_id,
    conversationId: row.conversation_id, runStatus: row.run_status,
    error: row.error ?? row.run_error,
    createdAt: row.created_at.toISOString(),
  };
}

function schedule(localTime: string, timeZone: string): Cron {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    const [hour, minute] = localTime.split(":").map(Number);
    return new Cron(`0 ${minute} ${hour} * * *`, { timezone: timeZone });
  } catch {
    throw new DomainError("时区或触发时间无效", 422, "routine_schedule_invalid");
  }
}

function matchesWallTime(date: Date, localTime: string, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date);
  const hour = parts.find(part => part.type === "hour")?.value;
  const minute = parts.find(part => part.type === "minute")?.value;
  return `${hour}:${minute}` === localTime;
}

export function nextRoutineFire(localTime: string, timeZone: string, after: Date): Date {
  const cron = schedule(localTime, timeZone);
  try {
    let cursor = after;
    for (let index = 0; index < 4; index++) {
      const next = cron.nextRun(cursor);
      if (!next) break;
      if (matchesWallTime(next, localTime, timeZone)) return next;
      cursor = next;
    }
    throw new DomainError("无法计算下次触发时间", 422, "routine_schedule_invalid");
  } finally { cron.stop(); }
}

export function latestRoutineFire(localTime: string, timeZone: string, now: Date): Date {
  const cron = schedule(localTime, timeZone);
  try {
    let cursor = new Date(now.getTime() - 32 * 24 * 60 * 60_000);
    let latest: Date | null = null;
    for (let index = 0; index < 40; index++) {
      const next = cron.nextRun(cursor);
      if (!next || next.getTime() > now.getTime()) break;
      if (matchesWallTime(next, localTime, timeZone)) latest = next;
      cursor = next;
    }
    if (!latest) throw new DomainError("无法计算最近触发时间", 422, "routine_schedule_invalid");
    return latest;
  } finally { cron.stop(); }
}

async function skillVersionFor(ownerId: string, skillId: string | null) {
  if (!skillId) return null;
  const result = await query<{ current_version: number }>(
    "SELECT current_version FROM skills WHERE owner_id=$1 AND id=$2", [ownerId, skillId],
  );
  if (!result.rows[0]) throw new DomainError("找不到技能", 404, "skill_not_found");
  return result.rows[0].current_version;
}

async function assertBot(ownerId: string, botId: string) {
  const result = await query("SELECT 1 FROM bots WHERE owner_id=$1 AND id=$2", [ownerId, botId]);
  if (!result.rowCount) throw new DomainError("找不到 Bot", 404, "bot_not_found");
}

export async function listRoutines(ownerId: string): Promise<Routine[]> {
  const result = await query<RoutineRow>(
    "SELECT * FROM routines WHERE owner_id=$1 ORDER BY updated_at DESC,id", [ownerId],
  );
  return result.rows.map(toRoutine);
}

export async function getRoutine(ownerId: string, routineId: string): Promise<Routine> {
  const result = await query<RoutineRow>(
    "SELECT * FROM routines WHERE owner_id=$1 AND id=$2", [ownerId, routineId],
  );
  if (!result.rows[0]) throw new DomainError("找不到例程", 404, "routine_not_found");
  return toRoutine(result.rows[0]);
}

export async function createRoutine(ownerId: string, input: RoutineInput): Promise<Routine> {
  await assertBot(ownerId, input.botId);
  const skillVersion = await skillVersionFor(ownerId, input.skillId);
  const next = nextRoutineFire(input.localTime, input.timeZone, new Date());
  const id = randomUUID();
  await query(
    `INSERT INTO routines(id,owner_id,bot_id,name,time_zone,local_time,input_text,deliverable,
     budget_json,skill_id,skill_version,next_fire_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, ownerId, input.botId, input.name, input.timeZone, input.localTime,
      input.inputText, input.deliverable, JSON.stringify(input.budget),
      input.skillId, skillVersion, next],
  );
  return getRoutine(ownerId, id);
}

export async function updateRoutine(ownerId: string, routineId: string, expectedRevision: number,
  input: Partial<RoutineInput> & { status?: "active" | "paused" }): Promise<Routine> {
  await transaction(async client => {
    const result = await client.query<RoutineRow>(
      "SELECT * FROM routines WHERE owner_id=$1 AND id=$2 FOR UPDATE", [ownerId, routineId],
    );
    const current = result.rows[0];
    if (!current) throw new DomainError("找不到例程", 404, "routine_not_found");
    if (current.revision !== expectedRevision) {
      throw new DomainError("例程已更新，请刷新后重试", 409, "routine_revision_conflict");
    }
    const botId = input.botId ?? current.bot_id;
    const bot = await client.query("SELECT 1 FROM bots WHERE owner_id=$1 AND id=$2", [ownerId, botId]);
    if (!bot.rowCount) throw new DomainError("找不到 Bot", 404, "bot_not_found");
    const skillId = input.skillId === undefined ? current.skill_id : input.skillId;
    let skillVersion = current.skill_version;
    if (input.skillId !== undefined) {
      if (skillId) {
        const skill = await client.query<{ current_version: number }>(
          "SELECT current_version FROM skills WHERE owner_id=$1 AND id=$2", [ownerId, skillId],
        );
        if (!skill.rows[0]) throw new DomainError("找不到技能", 404, "skill_not_found");
        skillVersion = skill.rows[0].current_version;
      } else skillVersion = null;
    }
    const localTime = input.localTime ?? current.local_time;
    const timeZone = input.timeZone ?? current.time_zone;
    const status = input.status ?? current.status;
    const changedSchedule = input.localTime !== undefined || input.timeZone !== undefined ||
      current.status === "paused" && status === "active";
    const next = changedSchedule
      ? nextRoutineFire(localTime, timeZone, new Date()) : current.next_fire_at;
    await client.query(
      `UPDATE routines SET bot_id=$3,name=$4,time_zone=$5,local_time=$6,input_text=$7,
       deliverable=$8,budget_json=$9,skill_id=$10,skill_version=$11,status=$12,next_fire_at=$13,
       revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2`,
      [ownerId, routineId, botId, input.name ?? current.name, timeZone, localTime,
        input.inputText ?? current.input_text, input.deliverable ?? current.deliverable,
        JSON.stringify(input.budget ?? current.budget_json), skillId, skillVersion, status, next],
    );
  });
  return getRoutine(ownerId, routineId);
}

async function insertOccurrence(client: import("pg").PoolClient, routine: RoutineRow,
  scheduledAt: Date, trigger: "scheduled" | "manual", manualRequestId: string | null) {
  await client.query(
    `INSERT INTO routine_occurrences(id,owner_id,routine_id,bot_id,routine_name,scheduled_at,trigger,
     manual_request_id,request_id,conversation_id,input_text,deliverable,budget_json,
     skill_id,skill_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), routine.owner_id, routine.id, routine.bot_id, routine.name,
      scheduledAt, trigger, manualRequestId, randomUUID(), randomUUID(), routine.input_text,
      routine.deliverable, JSON.stringify(routine.budget_json),
      routine.skill_id, routine.skill_version],
  );
}

export async function reserveDueRoutines(now = new Date()): Promise<number> {
  return transaction(async client => {
    const due = await client.query<RoutineRow>(
      `SELECT * FROM routines WHERE status='active' AND next_fire_at<=$1
       ORDER BY next_fire_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`, [now],
    );
    for (const routine of due.rows) {
      const latest = latestRoutineFire(routine.local_time, routine.time_zone, now);
      if (latest.getTime() < routine.next_fire_at.getTime()) {
        throw new Error(`Routine ${routine.id} has an invalid next_fire_at`);
      }
      await insertOccurrence(client, routine, latest, "scheduled", null);
      const next = nextRoutineFire(routine.local_time, routine.time_zone, latest);
      await client.query("UPDATE routines SET next_fire_at=$2,updated_at=now() WHERE id=$1",
        [routine.id, next]);
    }
    return due.rows.length;
  });
}

export async function listRoutineOccurrences(ownerId: string, routineId: string): Promise<RoutineOccurrence[]> {
  await getRoutine(ownerId, routineId);
  const result = await query<OccurrenceRow>(
    `SELECT o.*,r.status AS run_status,r.error AS run_error FROM routine_occurrences o
     LEFT JOIN runs r ON r.id=o.run_id WHERE o.owner_id=$1 AND o.routine_id=$2
     ORDER BY o.scheduled_at DESC,o.id DESC LIMIT 100`, [ownerId, routineId],
  );
  return result.rows.map(toOccurrence);
}

export async function testRoutine(ownerId: string, routineId: string,
  manualRequestId: string): Promise<RoutineOccurrence> {
  await transaction(async client => {
    const existing = await client.query(
      "SELECT 1 FROM routine_occurrences WHERE owner_id=$1 AND manual_request_id=$2",
      [ownerId, manualRequestId],
    );
    if (existing.rowCount) return;
    const found = await client.query<RoutineRow>(
      "SELECT * FROM routines WHERE owner_id=$1 AND id=$2 FOR UPDATE", [ownerId, routineId],
    );
    if (!found.rows[0]) throw new DomainError("找不到例程", 404, "routine_not_found");
    await insertOccurrence(client, found.rows[0], new Date(), "manual", manualRequestId);
  });
  const result = await query<OccurrenceRow>(
    `SELECT o.*,r.status AS run_status,r.error AS run_error FROM routine_occurrences o LEFT JOIN runs r ON r.id=o.run_id
     WHERE o.owner_id=$1 AND o.manual_request_id=$2`, [ownerId, manualRequestId],
  );
  const occurrence = result.rows[0];
  if (!occurrence || occurrence.routine_id !== routineId) {
    throw new DomainError("该试跑请求已用于另一例程", 409, "routine_request_conflict");
  }
  await dispatchOccurrence(occurrence);
  const latest = await query<OccurrenceRow>(
    `SELECT o.*,r.status AS run_status,r.error AS run_error FROM routine_occurrences o LEFT JOIN runs r ON r.id=o.run_id
     WHERE o.id=$1`, [occurrence.id],
  );
  return toOccurrence(latest.rows[0]);
}

async function dispatchOccurrence(item: OccurrenceRow): Promise<void> {
  if (item.status !== "pending") return;
  try {
    if (item.skill_id && item.skill_version) {
      const permissions = await query<{ required_capabilities: ToolCapability[];
        capabilities_json: ToolCapability[] }>(
        `SELECT v.required_capabilities,b.capabilities_json FROM skill_versions v
         JOIN bots b ON b.id=$3 AND b.owner_id=$4
         WHERE v.skill_id=$1 AND v.version=$2`,
        [item.skill_id, item.skill_version, item.bot_id, item.owner_id],
      );
      const row = permissions.rows[0];
      if (!row || !row.required_capabilities.every(capability =>
        row.capabilities_json.includes(capability))) {
        throw new DomainError("例程技能所需的 Bot 权限已撤销", 403, "routine_skill_capability_denied");
      }
    }
    await query(
      `INSERT INTO conversations(id,owner_id,bot_id,title) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [item.conversation_id, item.owner_id, item.bot_id, item.routine_name],
    );
    const submitted = await submitMessage(item.owner_id, item.conversation_id, {
      text: item.input_text, requestId: item.request_id, deliverable: item.deliverable,
    }, {
      budget: item.budget_json,
      skillVersion: item.skill_id && item.skill_version
        ? { skillId: item.skill_id, version: item.skill_version } : null,
    });
    await transaction(async client => {
      const updated = await client.query(
        `UPDATE routine_occurrences SET run_id=$2,status='submitted',error=NULL
         WHERE id=$1 AND status='pending' RETURNING id`, [item.id, submitted.run.id],
      );
      if (updated.rowCount) await addEvent(client, submitted.run.id, "routine_triggered", {
        routineId: item.routine_id, occurrenceId: item.id,
        scheduledAt: item.scheduled_at.toISOString(), trigger: item.trigger,
      });
    });
  } catch (error) {
    if (!(error instanceof DomainError) || error.statusCode >= 500) throw error;
    await query(
      `UPDATE routine_occurrences SET status='failed',error=$2 WHERE id=$1 AND status='pending'`,
      [item.id, error.message],
    );
  }
}

export async function dispatchPendingOccurrences(): Promise<number> {
  const result = await query<OccurrenceRow>(
    `SELECT o.*,NULL::text AS run_status,NULL::text AS run_error FROM routine_occurrences o
     WHERE o.status='pending' ORDER BY o.created_at,o.id LIMIT 20`,
  );
  for (const item of result.rows) await dispatchOccurrence(item);
  return result.rows.length;
}
