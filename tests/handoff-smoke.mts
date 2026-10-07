import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactDir } from "../packages/core/src/config.ts";
import { pool, query } from "../packages/core/src/db.ts";
import { readHandoffArtifact } from "../packages/core/src/handoffs.ts";

const base = "http://127.0.0.1:3841/api";
let cookie = "";

async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function api(path: string, method = "GET", body?: unknown) {
  const result = await request(path, method, body);
  assert.ok(result.status >= 200 && result.status < 300,
    `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function expectCode(path: string, method: string, body: unknown, status: number, code: string) {
  const result = await request(path, method, body);
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.code, code);
}

try {
  const database = await query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(database.rows[0].name, "opengrok_handoff_20261006", "refusing non-isolated DB");
  assert.equal((await request("/runs/00000000-0000-4000-8000-000000000000/handoffs")).status, 401);
  const setup = await api("/setup", "POST", {
    username: "handoff_smoke", password: `handoff-${randomUUID()}-password`,
  });
  const ownerId = setup.user.id as string;
  const profile = (await api("/model-profiles", "POST", {
    name: "Handoff fixture", provider: "openai-compatible", modelId: "handoff-fixture",
    baseUrl: "http://127.0.0.1:3850/v1",
    capabilities: { text: true, tools: true, vision: false, streaming: false },
  })).profile;
  async function bot(name: string, capabilities: string[]) {
    return (await api("/bots", "POST", {
      name, description: "交接测试", instructions: "", modelProfileId: profile.id, capabilities,
    })).bot;
  }
  const a = await bot("Research A", ["artifact", "memory", "delegate"]);
  const b = await bot("Review B", ["artifact", "memory", "delegate"]);
  const c = await bot("Check C", ["delegate"]);
  const d = await bot("Check D", ["delegate"]);
  const e = await bot("Check E", ["delegate"]);
  await api(`/bots/${a.id}/memories`, "POST", { kind: "preference", content: "只供 A 使用的测试偏好" });
  assert.equal((await api(`/bots/${b.id}/memories`)).memories.length, 0);

  async function rootRun() {
    const conversation = (await api(`/bots/${a.id}/conversations`, "POST", {})).conversation;
    return (await api(`/conversations/${conversation.id}/messages`, "POST", {
      text: "准备交接", requestId: randomUUID(), deliverable: "answer",
    })).run;
  }
  const root = await rootRun();
  const unrelated = await rootRun();
  const markdown = Buffer.from("# 已核对的上游材料\n\n结果：42。\n", "utf8");
  const artifactId = randomUUID();
  const path = join(artifactDir, root.id, `${artifactId}.md`);
  await mkdir(join(artifactDir, root.id), { recursive: true, mode: 0o700 });
  await writeFile(path, markdown, { flag: "wx", mode: 0o600 });
  await query(
    `INSERT INTO artifacts(id,owner_id,run_id,title,mime_type,sha256,size_bytes,storage_path,source_refs)
     VALUES ($1,$2,$3,'上游材料.md','text/markdown; charset=utf-8',$4,$5,$6,'[]')`,
    [artifactId, ownerId, root.id, createHash("sha256").update(markdown).digest("hex"),
      markdown.length, `${root.id}/${artifactId}.md`],
  );
  const task = { targetBotId: b.id, task: "复核上游结论", acceptance: "说明 42 的依据",
    deliverable: "answer", artifactIds: [artifactId] };
  const requestId = randomUUID();
  const created = await api(`/runs/${root.id}/handoffs`, "POST", { requestId, ...task });
  const child = created.run;
  assert.equal(child.parentRunId, root.id);
  assert.equal(child.rootRunId, root.id);
  assert.equal(child.delegationDepth, 1);
  assert.equal(child.budget.maxModelSteps, Math.floor(root.budget.maxModelSteps / 2));
  assert.equal((await api(`/runs/${root.id}/handoffs`, "POST", { requestId, ...task })).run.id,
    child.id);
  await expectCode(`/runs/${root.id}/handoffs`, "POST", { requestId, ...task,
    acceptance: "变化后的验收" }, 409, "handoff_request_conflict");
  const links = await api(`/runs/${root.id}/handoffs`);
  assert.equal(links.children.length, 1);
  assert.deepEqual(links.children[0].artifactIds, [artifactId]);
  assert.equal((await api(`/runs/${child.id}/handoffs`)).parent.id, root.id);
  const input = await api(`/conversations/${child.conversationId}/messages`);
  assert.match(input.messages[0].content, /复核上游结论/);
  assert.match(input.messages[0].content, new RegExp(artifactId));
  const firstPage = await readHandoffArtifact(ownerId, child.id, artifactId, 0, 10);
  assert.equal(firstPage.totalChars, Array.from(markdown.toString("utf8")).length);
  assert.ok(firstPage.nextOffset !== null);
  assert.match(firstPage.content, /已核对/);
  await assert.rejects(readHandoffArtifact(ownerId, unrelated.id, artifactId, 0, 10),
    { code: "handoff_artifact_denied" });
  await expectCode(`/runs/${unrelated.id}/handoffs`, "POST", {
    requestId: randomUUID(), ...task,
  }, 403, "handoff_artifact_denied");
  await expectCode(`/runs/${root.id}/handoffs`, "POST", {
    requestId: randomUUID(), ...task, targetBotId: c.id,
  }, 403, "handoff_artifact_capability_denied");
  await expectCode(`/runs/${child.id}/handoffs`, "POST", {
    requestId: randomUUID(), targetBotId: a.id, task: "返回 A", acceptance: "禁止循环",
    deliverable: "answer", artifactIds: [],
  }, 409, "handoff_cycle");

  const second = (await api(`/runs/${child.id}/handoffs`, "POST", {
    requestId: randomUUID(), targetBotId: c.id, task: "做第二级检查", acceptance: "完成检查",
    deliverable: "answer", artifactIds: [],
  })).run;
  assert.equal(second.delegationDepth, 2);
  await expectCode(`/runs/${second.id}/handoffs`, "POST", {
    requestId: randomUUID(), targetBotId: d.id, task: "再往下", acceptance: "禁止三级",
    deliverable: "answer", artifactIds: [],
  }, 409, "handoff_depth_exceeded");
  await api(`/runs/${child.id}/handoffs`, "POST", {
    requestId: randomUUID(), targetBotId: d.id, task: "第二个二级检查", acceptance: "完成检查",
    deliverable: "answer", artifactIds: [],
  });
  await expectCode(`/runs/${child.id}/handoffs`, "POST", {
    requestId: randomUUID(), targetBotId: e.id, task: "第四个子任务", acceptance: "数量封顶",
    deliverable: "answer", artifactIds: [],
  }, 409, "handoff_count_exceeded");

  const budgetRoot = await rootRun();
  for (const targetBotId of [b.id, c.id]) {
    await api(`/runs/${budgetRoot.id}/handoffs`, "POST", {
      requestId: randomUUID(), targetBotId, task: `交给 ${targetBotId}`,
      acceptance: "完成", deliverable: "answer", artifactIds: [],
    });
  }
  await expectCode(`/runs/${budgetRoot.id}/handoffs`, "POST", {
    requestId: randomUUID(), targetBotId: d.id, task: "超出总预算",
    acceptance: "预算封顶", deliverable: "answer", artifactIds: [],
  }, 409, "handoff_budget_exceeded");
  const count = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM runs WHERE root_run_id=$1", [root.id]);
  assert.equal(Number(count.rows[0].count), 3);
  console.log(JSON.stringify({ rootRunId: root.id, childRunId: child.id,
    descendantCount: Number(count.rows[0].count), artifactId,
    budgetRunId: budgetRoot.id, memoryIsolation: true }));
} finally {
  await pool.end();
}
