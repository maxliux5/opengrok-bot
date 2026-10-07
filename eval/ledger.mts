import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";

type Entry = Record<string, any>;
const path = process.env.OPENGROK_EVAL_RESULTS || ".local/eval/results-v1.jsonl";
const lines = (await readFile(path, "utf8")).trim().split("\n");
const entries = lines.map((line, index) => {
  try { return JSON.parse(line) as Entry; }
  catch { throw new Error(`评测账本第 ${index + 1} 行不是 JSON`); }
});
const [command, ...args] = process.argv.slice(2);

function needsReview(item: Entry) {
  return item.category === "research" || item.caseId === "m03_preference_to_report";
}

if (command === "review") {
  const [attemptId, decision, ...reasonParts] = args;
  assert.ok(attemptId && ["pass", "fail"].includes(decision) && reasonParts.length,
    "用法：ledger.mts review <attempt-id> <pass|fail> <具体原因>");
  const finished = entries.find(item => item.event === "attempt_finished" &&
    item.attemptId === attemptId);
  assert.ok(finished, `找不到已结束的尝试 ${attemptId}`);
  assert.ok(needsReview(finished), "此题由确定性检查验收，不需要人工评审");
  const reason = reasonParts.join(" ").trim();
  assert.ok(reason.length >= 8, "评审原因至少 8 个字符");
  const entry = {
    at: new Date().toISOString(), event: "manual_review", sessionId: finished.sessionId,
    attemptId, caseId: finished.caseId, manifestHash: finished.manifestHash,
    reviewer: process.env.OPENGROK_EVAL_REVIEWER || "codex-local",
    decision, reason,
  };
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", flag: "a" });
  console.log(JSON.stringify(entry));
} else if (command === "summary") {
  const sessionId = args[0] || entries.filter(item => item.event === "session_started").at(-1)?.sessionId;
  assert.ok(sessionId, "账本中没有评测会话");
  const session = entries.find(item => item.event === "session_started" &&
    item.sessionId === sessionId);
  assert.ok(session, `找不到评测会话 ${sessionId}`);
  const started = entries.filter(item => item.event === "attempt_started" &&
    item.sessionId === sessionId);
  const finished = entries.filter(item => item.event === "attempt_finished" &&
    item.sessionId === sessionId);
  const reviews = entries.filter(item => item.event === "manual_review" &&
    item.sessionId === sessionId);
  const latestReviews = new Map<string, Entry>();
  for (const review of reviews) latestReviews.set(review.attemptId, review);
  const missingFinished = started.filter(item => !finished.some(other =>
    other.attemptId === item.attemptId)).map(item => item.attemptId);
  const result = finished.map(item => {
    const review = latestReviews.get(item.attemptId);
    const qualified = Boolean(item.automatedPassed) &&
      (!needsReview(item) || review?.decision === "pass");
    return { caseId: item.caseId, category: item.category, attemptId: item.attemptId,
      automatedPassed: Boolean(item.automatedPassed), needsReview: needsReview(item),
      review: review?.decision || (needsReview(item) ? "pending" : "not_required"),
      qualified, stages: item.stages as Entry[] };
  });
  const stageRecords = result.flatMap(item => item.stages.filter(stage => stage.runId));
  const byCase = Object.fromEntries([...new Set(result.map(item => item.caseId))]
    .map(caseId => [caseId, { attempts: result.filter(item => item.caseId === caseId).length,
      automatedPassed: result.filter(item => item.caseId === caseId && item.automatedPassed).length,
      qualified: result.filter(item => item.caseId === caseId && item.qualified).length }]));
  console.log(JSON.stringify({ sessionId, provider: session.provider, modelId: session.modelId,
    manifestHash: session.manifestHash, runnerHash: session.runnerHash,
    appHash: session.appHash || null, variant: session.variant || "unrecorded",
    expectedAttempts: session.cases.length * session.repeats,
    startedAttempts: started.length, finishedAttempts: finished.length,
    missingFinished, automatedPassed: result.filter(item => item.automatedPassed).length,
    reviewPending: result.filter(item => item.review === "pending").length,
    reviewFailed: result.filter(item => item.review === "fail").length,
    qualified: result.filter(item => item.qualified).length,
    runCount: stageRecords.length,
    totalTokens: stageRecords.reduce((sum, stage) => sum + (stage.tokenCount || 0), 0),
    durationMs: finished.reduce((sum, item) => sum + (item.durationMs || 0), 0),
    failedToolCalls: stageRecords.flatMap(stage => stage.calls || [])
      .filter(call => call.status !== "succeeded").length,
    byCase }, null, 2));
} else {
  throw new Error("用法：ledger.mts summary [session-id] | review <attempt-id> <pass|fail> <原因>");
}
