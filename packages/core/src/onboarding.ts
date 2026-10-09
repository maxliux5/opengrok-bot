import { randomUUID } from "node:crypto";
import { open, readFile, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SetupCheck, WorkspaceDiagnostics } from "@opengrok/contracts";
import { artifactDir } from "./config.js";
import { query } from "./db.js";
import { hostRequest } from "./host-auth.js";

export async function diagnoseWorkspace(): Promise<WorkspaceDiagnostics> {
  const checks: SetupCheck[] = [{ id: "api", label: "工作空间服务", status: "ok", detail: "已登录，接口可用" }];
  const results = await Promise.allSettled([
    query<{ workers: number }>(`SELECT count(*)::int AS workers FROM service_heartbeats
      WHERE service_name='worker' AND last_seen_at >= now() - interval '20 seconds'`),
    hostRequest<{ computer: { status: string; controlMode: string; operationBusy?: boolean } }>("/state", {}, 4000),
    checkArtifactStorage(),
  ]);
  const [database, host, storage] = results;
  checks.push({ id: "database", label: "任务数据库", status: database.status === "fulfilled" ? "ok" : "error",
    detail: database.status === "fulfilled" ? "连接与任务表查询正常" : "数据库不可用，请检查数据库服务" });
  const workers = database.status === "fulfilled" ? database.value.rows[0].workers : 0;
  checks.push({ id: "workers", label: "后台执行器", status: database.status !== "fulfilled" ? "unchecked" : workers ? "ok" : "error",
    detail: database.status !== "fulfilled" ? "数据库不可用，无法检查心跳" : workers
      ? `${workers} 个执行器在线` : "20 秒内没有执行器心跳，请启动 Worker 服务" });
  const computer = host.status === "fulfilled" ? host.value.computer : null;
  checks.push({ id: "computer", label: "Linux 电脑", status: computer?.status === "ready"
    ? computer.controlMode === "agent" && !computer.operationBusy ? "ok" : "warning" : "error",
    detail: computer?.status !== "ready" ? "电脑未就绪，请检查桌面和 computer-host 服务" :
      computer.controlMode !== "agent" ? "电脑控制权交接或人工操作中" :
      computer.operationBusy ? "电脑正在执行操作" : "桌面运行时已就绪" });
  checks.push(storage.status === "fulfilled" ? storage.value : {
    id: "storage", label: "成果存储", status: "error", detail: "成果目录无法写入或回读，请检查磁盘与目录权限",
  });
  checks.push({ id: "web", label: "网页访问", status: "unchecked", detail: "等待首份报告验证实际网页读取" });
  return { checkedAt: new Date().toISOString(), checks };
}

async function checkArtifactStorage(): Promise<SetupCheck> {
  const content = randomUUID();
  const path = join(artifactDir, `.diagnostic-${content}`);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content);
    if (await readFile(path, "utf8") !== content) throw new Error("Storage verification failed");
    const disk = await statfs(artifactDir);
    const freePercent = disk.blocks ? Math.round(disk.bavail / disk.blocks * 100) : 0;
    return { id: "storage", label: "成果存储", status: freePercent < 5 ? "warning" : "ok",
      detail: `写入和回读正常，可用空间 ${freePercent}%` };
  } finally {
    await file.close();
    await unlink(path);
  }
}
