import assert from "node:assert/strict";
import { testPassword } from "./test-password.mjs";
import { createHash, randomUUID } from "node:crypto";
import { chromium, type Browser } from "playwright";
import { canonicalJson } from "../packages/contracts/src/index.ts";
import { computerAccess, createBot, createConversation, createModelProfile, hostRequest,
  markCallDispatching, migrate, pool, query, recordCallResult, submitMessage } from
  "../packages/core/src/index.ts";

const base = "http://127.0.0.1:3841/api";
const workerId = "shell-command-stop-smoke";
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let cookie = "";
let runId: string | null = null;
let botId: string | null = null;
let callId: string | null = null;
let browser: Browser | null = null;

async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

try {
  await migrate();
  await api("/login", "POST", { username: "smoke", password: testPassword });
  const owner = await query<{ id: string }>("SELECT id FROM users WHERE username='smoke'");
  const ownerId = owner.rows[0]?.id;
  assert.ok(ownerId);
  const profile = await createModelProfile(ownerId, {
    name: `Shell stop ${Date.now()}`, provider: "openai-compatible", modelId: "test-model",
    baseUrl: "http://127.0.0.1:3850/v1",
  });
  const bot = await createBot(ownerId, {
    name: `Shell stop ${Date.now()}`, description: "", instructions: "",
    modelProfileId: profile.id, capabilities: ["shell"],
  });
  botId = bot.id;
  const conversation = await createConversation(ownerId, bot.id);
  const submitted = await submitMessage(ownerId, conversation.id, {
    text: "验证逐命令停止", requestId: randomUUID(), deliverable: "answer",
  });
  runId = submitted.run.id;
  await query(`UPDATE runs SET status='running',lease_owner=$2,lease_epoch=1,
    lease_until=now()+interval '2 minutes' WHERE id=$1`, [runId, workerId]);
  const stepId = randomUUID();
  await query(`INSERT INTO model_steps(id,run_id,ordinal,input_revision,model_profile_id,status,
    input_snapshot,output_snapshot) VALUES ($1,$2,1,1,$3,'completed','[]'::jsonb,'{}'::jsonb)`,
  [stepId, runId, profile.id]);
  const args = { command: "sleep 8", timeoutMs: 15_000 };
  const argsHash = createHash("sha256").update(canonicalJson(args)).digest("hex");
  const operationId = randomUUID();
  callId = randomUUID();
  await query(`INSERT INTO tool_calls(id,run_id,step_id,operation_id,ordinal,name,args,args_hash,
    status,replay_policy) VALUES ($1,$2,$3,$4,0,'shell_exec',$5,$6,'authorized','manual_only')`,
  [callId, runId, stepId, operationId, JSON.stringify(args), argsHash]);
  const access = await computerAccess();
  assert.equal(access.ready, true);
  await query(`INSERT INTO approvals(id,owner_id,run_id,call_id,target,args_hash,context_version,
    expires_at,status,decided_at,computer_generation,control_epoch)
    VALUES ($1,$2,$3,$4,'/workspace: sleep 8',$5,1,now()+interval '1 minute',
    'approved',now(),$6,$7)`,
  [randomUUID(), ownerId, runId, callId, argsHash, access.generation, access.controlEpoch]);
  await markCallDispatching(callId, runId, workerId, 1);
  const operation = hostRequest<{ outcome: "succeeded" | "failed" | "unknown";
    result: { exitCode: number | null; signal: string | null; stoppedByUser: boolean;
      timedOut: boolean } }>("/operations", { method: "POST",
    body: JSON.stringify({ operationId, runId, epoch: 1, controlEpoch: access.controlEpoch,
      name: "shell_exec", args, argsHash, deadline: Date.now() + 20_000 }),
  }, 25_000);

  let executing = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const commands = (await api(`/runs/${runId}/shell-commands`)).commands;
    const state = await hostRequest<{ computer: { operationBusy: boolean } }>("/state", {}, 4000);
    if (commands[0]?.status === "dispatching" && state.computer.operationBusy) {
      executing = true; break;
    }
    await wait(100);
  }
  assert.equal(executing, true);
  const before = (await api(`/runs/${runId}/shell-commands`)).commands[0];
  assert.equal(before.command, "sleep 8");
  assert.equal(before.timeoutMs, 15_000);
  assert.equal(before.stopRequestedAt, null);

  let delivery = "web";
  if (process.env.OPENGROK_STOP_VIA_WEB === "1") {
    browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:5174",
      viewport: { width: 1280, height: 850 } });
    const page = await context.newPage();
    page.on("dialog", dialog => void dialog.accept());
    const login = await context.request.post("/api/login", { data: {
      username: "smoke", password: testPassword,
    } });
    assert.equal(login.ok(), true);
    await page.goto("/");
    await page.locator(".bot-row").filter({ hasText: bot.name }).click();
    await page.locator(".conversation-row").filter({ hasText: "验证逐命令停止" }).click();
    await page.getByRole("tab", { name: "活动" }).click();
    const row = page.locator(".shell-command").filter({ hasText: "sleep 8" });
    await row.getByRole("button", { name: "停止这条命令" }).click();
    await row.getByText("停止请求已发出").waitFor();
    await page.screenshot({ path: ".local/web-shell-stop-inflight.png" });
    await context.close();
  } else {
    const stopped = await api(`/runs/${runId}/shell-commands/${operationId}/stop`, "POST", {});
    assert.equal(stopped.stop.stopRequested, true);
    assert.ok(["stopping", "pending"].includes(stopped.delivery));
    delivery = stopped.delivery;
  }
  const afterRequest = (await api(`/runs/${runId}/shell-commands`)).commands[0];
  assert.ok(afterRequest.stopRequestedAt);
  const runDuring = (await api(`/runs/${runId}`)).run;
  assert.equal(runDuring.cancelRequested, undefined);
  assert.equal(runDuring.status, "running");
  const rawRun = await query<{ cancel_requested: boolean }>(
    "SELECT cancel_requested FROM runs WHERE id=$1", [runId]);
  assert.equal(rawRun.rows[0].cancel_requested, false);

  const receipt = await operation;
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.result.stoppedByUser, true);
  assert.equal(receipt.result.signal, "SIGTERM");
  assert.equal(receipt.result.timedOut, false);
  await recordCallResult(callId, runId, workerId, 1, receipt.outcome, receipt.result);
  const final = (await api(`/runs/${runId}/shell-commands`)).commands[0];
  assert.equal(final.status, "succeeded");
  assert.equal(final.result.stoppedByUser, true);
  console.log(JSON.stringify({ runId, operationId, delivery,
    signal: final.result.signal, stoppedByUser: final.result.stoppedByUser,
    runStillRunning: runDuring.status === "running", command: final.command }));
} finally {
  await browser?.close();
  if (runId) await query(`UPDATE runs SET status='failed',error='逐命令停止测试结束',
    lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [runId]);
  if (runId) await query(
    "UPDATE bot_execution_slots SET active_run_id=NULL,revision=revision+1 WHERE active_run_id=$1",
    [runId],
  );
  if (botId) await query("UPDATE bots SET model_profile_id=NULL WHERE id=$1", [botId]);
  await pool.end();
}
