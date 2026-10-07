import { randomUUID } from "node:crypto";
import pg from "../packages/core/node_modules/pg/esm/index.mjs";
import {
  cancelRun, createBot, createConversation, databaseConfig, finishRun, pool,
  query, submitMessage, transaction,
} from "../packages/core/src/index.ts";

const owner = await query<{ id: string }>("SELECT id FROM users WHERE username='smoke'");
const ownerId = owner.rows[0]?.id;
if (!ownerId) throw new Error("Smoke account is missing");
const profiles = await query<{ id: string }>(
  "SELECT id FROM model_profiles WHERE owner_id=$1 LIMIT 1", [ownerId],
);
const profileId = profiles.rows[0]?.id;
if (!profileId) throw new Error("Smoke model profile is missing");

async function fixture() {
  const bot = await createBot(ownerId, {
    name: `Input-finish race ${Date.now()}`, description: "", instructions: "", modelProfileId: profileId,
  });
  const conversation = await createConversation(ownerId, bot.id);
  const submitted = await submitMessage(ownerId, conversation.id, {
    text: "Original request", requestId: randomUUID(), deliverable: "answer",
  });
  const workerId = `race-${randomUUID()}`;
  const epoch = await transaction(async client => {
    await client.query("UPDATE bot_execution_slots SET active_run_id=$2 WHERE bot_id=$1", [bot.id, submitted.run.id]);
    const updated = await client.query<{ lease_epoch: string }>(
      `UPDATE runs SET status='running',lease_owner=$2,lease_epoch=lease_epoch+1,
       lease_until=now()+interval '10 minutes' WHERE id=$1 RETURNING lease_epoch`,
      [submitted.run.id, workerId],
    );
    return Number(updated.rows[0].lease_epoch);
  });
  return { conversation, runId: submitted.run.id, workerId, epoch };
}

async function waitBlocked(fragment: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const active = await query<{ query: string }>(
      `SELECT query FROM pg_stat_activity WHERE datname=current_database()
       AND wait_event_type='Lock' AND pid<>pg_backend_pid()`,
    );
    if (active.rows.some(row => row.query.includes(fragment))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected database lock wait not observed: ${fragment}`);
}

async function runCase(first: "finish" | "input") {
  const setup = await fixture();
  const locker = new pg.Client(databaseConfig);
  await locker.connect();
  let locked = false;
  let finish: Promise<"succeeded" | "requeued" | "lost"> | undefined;
  let supplement: ReturnType<typeof submitMessage> | undefined;
  try {
    await locker.query("BEGIN");
    locked = true;
    await locker.query("SELECT id FROM conversations WHERE id=$1 FOR UPDATE", [setup.conversation.id]);
    const submit = () => submitMessage(ownerId, setup.conversation.id, {
      text: `Supplement ${first}`, requestId: randomUUID(), deliverable: "answer",
    });
    const finishNow = () => finishRun(setup.runId, setup.workerId, setup.epoch, 1, "Original reply");
    if (first === "finish") {
      finish = finishNow();
      await waitBlocked("FROM conversations c JOIN runs r");
      await locker.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE NOWAIT", [setup.runId]);
      supplement = submit();
      await waitBlocked("SELECT c.bot_id,c.title,b.model_profile_id");
    } else {
      supplement = submit();
      await waitBlocked("SELECT c.bot_id,c.title,b.model_profile_id");
      finish = finishNow();
      await waitBlocked("FROM conversations c JOIN runs r");
    }
    await locker.query("COMMIT");
    locked = false;
    const [finished, added] = await Promise.all([finish, supplement]);
    const run = await query<{ status: string; input_revision: number }>(
      "SELECT status,input_revision FROM runs WHERE id=$1", [setup.runId],
    );
    const inputs = await query<{ count: string }>(
      "SELECT count(*)::text AS count FROM run_inputs WHERE run_id=$1", [added.run.id],
    );
    const result = { first, finish: finished, oldRun: setup.runId, newRun: added.run.id,
      oldStatus: run.rows[0].status, revision: run.rows[0].input_revision,
      inputCount: Number(inputs.rows[0].count) };
    await cancelRun(ownerId, added.run.id);
    return result;
  } finally {
    if (locked) await locker.query("ROLLBACK");
    await locker.end();
  }
}

try {
  const finishFirst = await runCase("finish");
  const inputFirst = await runCase("input");
  console.log(JSON.stringify({ finishFirst, inputFirst }));
  if (finishFirst.finish !== "succeeded" || finishFirst.newRun === finishFirst.oldRun ||
    finishFirst.inputCount !== 1 || inputFirst.finish !== "requeued" ||
    inputFirst.newRun !== inputFirst.oldRun || inputFirst.revision !== 2 ||
    inputFirst.inputCount !== 2) process.exitCode = 1;
} finally {
  await pool.end();
}
