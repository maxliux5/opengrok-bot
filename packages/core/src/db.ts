import { readFile } from "node:fs/promises";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import { databaseConfig } from "./config.js";

export const pool = new pg.Pool({ ...databaseConfig, max: 12 });

export async function query<T extends QueryResultRow>(sql: string, args: unknown[] = []) {
  return pool.query<T>(sql, args);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(): Promise<void> {
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(612031587)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const [version, file] of [
      [1, "001_initial.sql"], [2, "002_tool_identity.sql"],
      [3, "003_step_inputs.sql"], [4, "004_expected_artifact.sql"],
      [5, "005_artifact_identity.sql"],
      [6, "006_approval_computer_context.sql"],
      [7, "007_run_budget.sql"],
      [8, "008_bot_capabilities.sql"],
      [9, "009_default_bot_capabilities.sql"],
      [10, "010_model_capabilities.sql"],
      [11, "011_desktop_approvals.sql"],
      [12, "012_shell_stop_requests.sql"],
      [13, "013_relative_artifact_paths.sql"],
      [14, "014_service_heartbeats.sql"],
      [15, "015_skills.sql"],
      [16, "016_routines.sql"],
      [17, "017_handoffs.sql"],
      [18, "018_github_issues.sql"],
    ] as const) {
      const applied = await client.query("SELECT version FROM schema_migrations WHERE version=$1", [version]);
      if (applied.rowCount) continue;
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
    }
  });
}
