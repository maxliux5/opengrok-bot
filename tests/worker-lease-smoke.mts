import { randomUUID } from "node:crypto";
import {
  claimNextRun, createBot, createConversation, finishRun, heartbeat, pool,
  query, recoverExpiredRuns, submitMessage,
} from "../packages/core/src/index.ts";

try {
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE username='smoke'");
  const ownerId = owner.rows[0]?.id;
  if (!ownerId) throw new Error("Smoke account is missing");
  const profiles = await query<{ id: string }>(
    "SELECT id FROM model_profiles WHERE owner_id=$1 LIMIT 1", [ownerId],
  );
  const profileId = profiles.rows[0]?.id;
  if (!profileId) throw new Error("Smoke model profile is missing");
  const bot = await createBot(ownerId, {
    name: `Worker lease ${Date.now()}`, description: "", instructions: "", modelProfileId: profileId,
  });
  const runs: string[] = [];
  for (let index = 0; index < 2; index++) {
    const conversation = await createConversation(ownerId, bot.id);
    const submitted = await submitMessage(ownerId, conversation.id, {
      text: `Lease test ${index}`, requestId: randomUUID(), deliverable: "answer",
    });
    runs.push(submitted.run.id);
  }

  const [left, right] = await Promise.all([
    claimNextRun("lease-worker-left"), claimNextRun("lease-worker-right"),
  ]);
  const initial = [left, right].filter(item => item !== null);
  if (initial.length !== 1 || !runs.includes(initial[0].runId)) {
    throw new Error(`Expected one Bot slot holder: ${JSON.stringify({ left, right })}`);
  }
  const first = initial[0];
  const originalWorker = left ? "lease-worker-left" : "lease-worker-right";
  const otherRun = runs.find(id => id !== first.runId)!;
  const before = await query<{ active_run_id: string }>(
    "SELECT active_run_id FROM bot_execution_slots WHERE bot_id=$1", [bot.id],
  );
  await query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1", [first.runId]);
  await recoverExpiredRuns();
  const expired = await query<{ status: string; active_run_id: string }>(
    `SELECT r.status,s.active_run_id FROM runs r JOIN bot_execution_slots s ON s.bot_id=r.bot_id
     WHERE r.id=$1`, [first.runId],
  );
  const reclaimed = await claimNextRun("lease-worker-recovery");
  const oldHeartbeat = await heartbeat(first.runId, originalWorker, first.epoch);
  const oldFinish = await finishRun(first.runId, originalWorker, first.epoch, 1, "Stale reply");
  const newFinish = reclaimed ? await finishRun(reclaimed.runId, "lease-worker-recovery",
    reclaimed.epoch, 1, "Recovered reply") : "lost";
  const next = await claimNextRun("lease-worker-next");
  const nextFinish = next ? await finishRun(next.runId, "lease-worker-next", next.epoch, 1,
    "Queued reply") : "lost";
  const final = await query<{ active_run_id: string | null }>(
    "SELECT active_run_id FROM bot_execution_slots WHERE bot_id=$1", [bot.id],
  );
  const messages = await query<{ run_id: string; count: string }>(
    `SELECT run_id,count(*)::text AS count FROM messages
     WHERE run_id=ANY($1::uuid[]) AND role='assistant' GROUP BY run_id`, [runs],
  );
  console.log(JSON.stringify({ initial, before: before.rows[0], expired: expired.rows[0],
    reclaimed, oldHeartbeat, oldFinish, newFinish, next, nextFinish,
    final: final.rows[0], assistantMessages: messages.rows }));
  if (before.rows[0].active_run_id !== first.runId ||
    expired.rows[0].status !== "queued" || expired.rows[0].active_run_id !== first.runId ||
    reclaimed?.runId !== first.runId || reclaimed.epoch <= first.epoch ||
    oldHeartbeat || oldFinish !== "lost" || newFinish !== "succeeded" ||
    next?.runId !== otherRun || nextFinish !== "succeeded" ||
    final.rows[0].active_run_id !== null || messages.rows.length !== 2 ||
    messages.rows.some(row => Number(row.count) !== 1)) process.exitCode = 1;
} finally {
  await pool.end();
}
