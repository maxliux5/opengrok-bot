import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pool, query } from "../packages/core/src/db.ts";
import { resolveArtifactPath } from "../packages/core/src/artifact-path.ts";

const [sessionArg, caseArg] = process.argv.slice(2);
const path = process.env.OPENGROK_EVAL_RESULTS || ".local/eval/results-v1.jsonl";
const entries = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const sessionId = sessionArg || entries.filter(item => item.event === "session_started").at(-1)?.sessionId;
assert.ok(sessionId, "需要评测会话 ID");
const databaseName = process.env.OPENGROK_EVAL_DB_NAME || "opengrok_test";
assert.ok(databaseName === "opengrok_test" || /^opengrok_eval_\d{8}(?:_[a-z])?$/.test(databaseName),
  "报告只能从指定的隔离评测库读取");

try {
  const db = await query<{ name: string }>("SELECT current_database() AS name");
  assert.equal(db.rows[0]?.name, databaseName, "报告读取进程未连接指定的隔离数据库");
  const attempts = entries.filter(item => item.event === "attempt_finished" &&
    item.sessionId === sessionId &&
    (item.category === "research" || item.caseId === "m03_preference_to_report") &&
    (!caseArg || item.caseId === caseArg));
  for (const item of attempts) {
    const runId = item.stages.at(-1)?.runId;
    if (!runId) {
      console.log(`\n### ${item.caseId} ${item.attemptId}\n无完整 Run；${JSON.stringify(item.stages)}`);
      continue;
    }
    const artifacts = await query<{ storage_path: string; source_refs: string[] }>(
      "SELECT storage_path,source_refs FROM artifacts WHERE run_id=$1 AND mime_type LIKE 'text/markdown%' ORDER BY created_at",
      [runId],
    );
    const started = entries.find(entry => entry.event === "attempt_started" &&
      entry.attemptId === item.attemptId);
    console.log(`\n### ${item.caseId} ${item.attemptId}\nRun: ${runId}\n审阅：${started?.reviewQuestion || "未登记"}`);
    if (artifacts.rows.length !== 1) {
      console.log(`报告数量：${artifacts.rows.length}`);
      continue;
    }
    console.log(`登记来源：${JSON.stringify(artifacts.rows[0].source_refs)}\n`);
    console.log(await readFile(resolveArtifactPath(artifacts.rows[0].storage_path), "utf8"));
  }
} finally {
  await pool.end();
}
