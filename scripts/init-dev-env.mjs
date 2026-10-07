import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = join(import.meta.dirname, "..", ".local");
const path = join(directory, "dev.env");
await mkdir(directory, { recursive: true, mode: 0o700 });
try {
  const existing = await readFile(path, "utf8");
  if (!existing.includes("DATABASE_URL=")) throw new Error("Existing dev.env is incomplete");
  console.log(`Development configuration already exists: ${path}`);
} catch (error) {
  if ((error).code !== "ENOENT") throw error;
  const password = randomBytes(24).toString("hex");
  const lines = [
    "POSTGRES_USER=opengrok",
    `POSTGRES_PASSWORD=${password}`,
    "POSTGRES_DB=opengrok_bot",
    `DATABASE_URL=postgresql://opengrok:${password}@127.0.0.1:55433/opengrok_bot`,
  ];
  await writeFile(path, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Created development configuration: ${path}`);
}
