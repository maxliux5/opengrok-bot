import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";
import { DomainError } from "./errors.js";

export function hostToken(): string {
  const configured = process.env.OPENGROK_HOST_TOKEN;
  if (configured) return configured;
  const path = join(dataDir, "host.token");
  try {
    writeFileSync(path, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(path, "utf8").trim();
}

export async function hostRequest<T>(path: string, options: RequestInit = {}, timeoutMs = 125_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${process.env.OPENGROK_HOST_URL || "http://127.0.0.1:3842"}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${hostToken()}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new DomainError(
      data.error || `电脑服务返回 ${response.status}`, response.status, "host_rejected",
    );
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}
