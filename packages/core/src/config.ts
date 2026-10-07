import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { runBudgetSchema } from "@opengrok/contracts";

export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const dataDir = resolve(projectRoot, process.env.OPENGROK_DATA_DIR || ".local");
export const artifactDir = join(dataDir, "artifacts");

function limit(name: string, fallback: number): number {
  return process.env[name] === undefined ? fallback : Number(process.env[name]);
}

export const defaultRunBudget = runBudgetSchema.parse({
  maxModelSteps: limit("OPENGROK_MAX_MODEL_STEPS", 12),
  maxToolCalls: limit("OPENGROK_MAX_TOOL_CALLS", 30),
  maxTokens: limit("OPENGROK_MAX_TOKENS", 40_000),
  maxWallMs: limit("OPENGROK_MAX_RUN_WALL_MS", 24 * 60 * 60_000),
  maxModelCallMs: limit("OPENGROK_MAX_MODEL_CALL_MS", 120_000),
  maxModelOutputTokens: limit("OPENGROK_MAX_MODEL_OUTPUT_TOKENS", 2048),
  maxArtifactBytes: limit("OPENGROK_MAX_ARTIFACT_BYTES", 2_000_000),
});

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(artifactDir, { recursive: true, mode: 0o700 });

export const databaseConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: dataDir,
      port: Number(process.env.OPENGROK_DB_PORT || 55432),
      database: process.env.OPENGROK_DB_NAME || "opengrok_bot",
      user: process.env.OPENGROK_DB_USER || process.env.USER || "postgres",
    };
