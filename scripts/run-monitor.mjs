import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const env = { ...process.env };
const config = await readFile(join(root, ".local/dev.env"), "utf8");
for (const line of config.split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!match) throw new Error("Invalid local environment configuration");
  env[match[1]] ??= match[2];
}
env.NODE_EXTRA_CA_CERTS ??= join(root, ".local/tls/cert.pem");
const child = spawn(join(root, "node_modules/.bin/tsx"), [join(root, "scripts/monitor.mts")], {
  cwd: root, env, stdio: "inherit",
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.once("error", error => { console.error(error); process.exitCode = 2; });
child.once("exit", code => { process.exitCode = code ?? 2; });
