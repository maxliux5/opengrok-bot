import { execFileSync } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { dataDir } from "../packages/core/src/config.ts";
import { pool, query } from "../packages/core/src/db.ts";

type Severity = "warn" | "critical";
const issues: Array<{ severity: Severity; code: string; detail: string }> = [];
const result: Record<string, unknown> = { at: new Date().toISOString() };

function threshold(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须是非负数`);
  return value;
}

function issue(severity: Severity, code: string, detail: string) {
  issues.push({ severity, code, detail });
}

async function health(name: string, url: string, token?: string) {
  try {
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return body;
  } catch (error) {
    result[name] = { reachable: false };
    issue("critical", `${name}_unavailable`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function checkServices() {
  const webUrl = process.env.OPENGROK_MONITOR_WEB_URL || "https://127.0.0.1:8443/";
  try {
    const response = await fetch(webUrl, { signal: AbortSignal.timeout(3000) });
    result.web = { status: response.status };
    if (!response.ok) issue("critical", "web_unavailable", `HTTP ${response.status}`);
  } catch (error) {
    result.web = { reachable: false };
    issue("critical", "web_unavailable", error instanceof Error ? error.message : String(error));
  }
  const api = await health("api", process.env.OPENGROK_MONITOR_API_URL || "http://127.0.0.1:3848/api/health");
  if (api) result.api = { ok: api.ok === true };
  if (api && api.ok !== true) issue("critical", "api_unhealthy", "API 未返回 ok=true");
  const hostToken = (await readFile(join(dataDir, "host.token"), "utf8")).trim();
  const host = await health("host", process.env.OPENGROK_MONITOR_HOST_URL || "http://127.0.0.1:3842/state", hostToken);
  const computer = host?.computer as { status?: string; operationBusy?: boolean } | undefined;
  if (host) result.host = { status: computer?.status, operationBusy: computer?.operationBusy };
  if (host && computer?.status !== "ready") issue("critical", "computer_unready", computer?.status || "unknown");
  const runtimeTokenLine = (await readFile(join(dataDir, "desktop.env"), "utf8"))
    .split("\n").find(line => line.startsWith("OPENGROK_RUNTIME_TOKEN="));
  if (!runtimeTokenLine) throw new Error("缺少桌面 runtime token");
  const runtime = await health("desktop", process.env.OPENGROK_MONITOR_DESKTOP_URL ||
    "http://127.0.0.1:3843/health", runtimeTokenLine.slice("OPENGROK_RUNTIME_TOKEN=".length));
  if (runtime) result.desktop = { ready: runtime.ready === true,
    mode: runtime.mode, busy: runtime.busy };
  if (runtime && runtime.ready !== true) issue("critical", "desktop_unready", "桌面健康检查未返回 ready=true");
  try {
    const port = Number(process.env.OPENGROK_EGRESS_PORT || 3888);
    const firewall = JSON.parse(execFileSync("sudo", ["-n", process.execPath,
      join(import.meta.dirname, "desktop-firewall.mjs"), "verify", "desktop_default", String(port)],
    { encoding: "utf8", timeout: 3000 })) as { gateway: string; status: string };
    result.desktopFirewall = { status: firewall.status };
    const gateway = await health("egressGateway", `http://${firewall.gateway}:${port}/health`);
    if (gateway && gateway.ok !== true) issue("critical", "egress_gateway_unhealthy", "出口网关未返回 ok=true");
  } catch (error) {
    result.desktopFirewall = { status: "unavailable" };
    issue("critical", "desktop_firewall_unavailable", error instanceof Error ? error.message : String(error));
  }
}

async function checkDatabase() {
  const status = await query<{
    queued_ready: number; oldest_queued_seconds: number; failed_last_hour: number;
    waiting_approval: number; waiting_computer: number;
  }>(`SELECT
    count(*) FILTER (WHERE status='queued' AND next_wake_at <= now())::int AS queued_ready,
    coalesce(max(extract(epoch FROM now() - created_at)) FILTER
      (WHERE status='queued' AND next_wake_at <= now()),0)::int AS oldest_queued_seconds,
    count(*) FILTER (WHERE status='failed' AND updated_at >= now() - interval '1 hour')::int AS failed_last_hour,
    count(*) FILTER (WHERE status='waiting_approval')::int AS waiting_approval,
    count(*) FILTER (WHERE status='waiting_computer')::int AS waiting_computer
    FROM runs`);
  const workers = await query<{ fresh: number; stale: number }>(`SELECT
    count(*) FILTER (WHERE last_seen_at >= now() - interval '20 seconds')::int AS fresh,
    count(*) FILTER (WHERE last_seen_at < now() - interval '20 seconds')::int AS stale
    FROM service_heartbeats WHERE service_name='worker'`);
  const usage = await query<{ steps: number; estimated_steps: number; budgeted_tokens: string }>(`SELECT
    count(*)::int AS steps,
    count(*) FILTER (WHERE usage_json->>'estimated'='true')::int AS estimated_steps,
    coalesce(sum((usage_json->>'budgetedTokens')::bigint),0)::text AS budgeted_tokens
    FROM model_steps WHERE completed_at >= now() - interval '1 hour'
      AND status IN ('completed','obsolete')`);
  const routines = await query<{ due: number; oldest_due_seconds: number;
    pending: number; oldest_pending_seconds: number; failed_last_hour: number }>(`SELECT
    (SELECT count(*)::int FROM routines WHERE status='active' AND next_fire_at<=now()) AS due,
    (SELECT coalesce(max(extract(epoch FROM now()-next_fire_at)),0)::int
      FROM routines WHERE status='active' AND next_fire_at<=now()) AS oldest_due_seconds,
    (SELECT count(*)::int FROM routine_occurrences WHERE status='pending') AS pending,
    (SELECT coalesce(max(extract(epoch FROM now()-created_at)),0)::int
      FROM routine_occurrences WHERE status='pending') AS oldest_pending_seconds,
    (SELECT count(*)::int FROM routine_occurrences
      WHERE status='failed' AND created_at>=now()-interval '1 hour') AS failed_last_hour`);
  result.queue = status.rows[0];
  result.routines = routines.rows[0];
  result.workers = workers.rows[0];
  result.modelUsageLastHour = { steps: usage.rows[0].steps,
    estimatedSteps: usage.rows[0].estimated_steps,
    budgetedTokens: Number(usage.rows[0].budgeted_tokens) };
  const minWorkers = Number(process.env.OPENGROK_MIN_WORKERS || 1);
  if (!Number.isInteger(minWorkers) || minWorkers < 1 || minWorkers > 16) {
    throw new Error("OPENGROK_MIN_WORKERS 必须在 1 到 16 之间");
  }
  if (workers.rows[0].fresh < minWorkers) issue("critical", "worker_missing",
    `20 秒内只有 ${workers.rows[0].fresh}/${minWorkers} 个 Worker 心跳`);
  const queueWarn = threshold("OPENGROK_MONITOR_QUEUE_WARN_SECONDS", 300);
  if (status.rows[0].oldest_queued_seconds >= queueWarn && status.rows[0].queued_ready > 0) {
    issue("warn", "queue_delay", `最早可执行任务已等待 ${status.rows[0].oldest_queued_seconds} 秒`);
  }
  const failedWarn = threshold("OPENGROK_MONITOR_FAILED_WARN_PER_HOUR", 5);
  if (status.rows[0].failed_last_hour >= failedWarn && failedWarn > 0) {
    issue("warn", "run_failures", `近一小时失败 Run ${status.rows[0].failed_last_hour} 个`);
  }
  const routineDelayWarn = threshold("OPENGROK_MONITOR_ROUTINE_WARN_SECONDS", 120);
  if (routines.rows[0].oldest_due_seconds >= routineDelayWarn && routines.rows[0].due > 0) {
    issue("warn", "routine_due_delay", `例程已逾期 ${routines.rows[0].oldest_due_seconds} 秒`);
  }
  if (routines.rows[0].oldest_pending_seconds >= routineDelayWarn && routines.rows[0].pending > 0) {
    issue("warn", "routine_dispatch_delay", `例程投递已等待 ${routines.rows[0].oldest_pending_seconds} 秒`);
  }
  if (routines.rows[0].failed_last_hour >= failedWarn && failedWarn > 0) {
    issue("warn", "routine_failures", `近一小时例程投递失败 ${routines.rows[0].failed_last_hour} 次`);
  }
}

async function checkDisk() {
  const disk = await statfs(dataDir);
  const freeBytes = disk.bavail * disk.bsize;
  const totalBytes = disk.blocks * disk.bsize;
  const freePercent = totalBytes > 0 ? Math.round(freeBytes / totalBytes * 10000) / 100 : 0;
  result.disk = { freeBytes, totalBytes, freePercent, path: dataDir };
  if (freePercent < threshold("OPENGROK_MONITOR_DISK_CRITICAL_PERCENT", 5)) {
    issue("critical", "disk_low", `可用空间 ${freePercent}%`);
  } else if (freePercent < threshold("OPENGROK_MONITOR_DISK_WARN_PERCENT", 15)) {
    issue("warn", "disk_low", `可用空间 ${freePercent}%`);
  }
}

try {
  await checkServices();
  await checkDatabase();
  await checkDisk();
} catch (error) {
  issue("critical", "monitor_failed", error instanceof Error ? error.message : String(error));
} finally {
  await pool.end();
}
result.issues = issues;
result.status = issues.some(item => item.severity === "critical") ? "critical" :
  issues.length ? "warn" : "ok";
console.log(JSON.stringify(result));
process.exitCode = result.status === "critical" ? 2 : result.status === "warn" ? 1 : 0;
