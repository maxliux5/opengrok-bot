import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const key = join(root, ".local", "tls", "key.pem");
const cert = join(root, ".local", "tls", "cert.pem");
await Promise.all([key, cert, join(root, "apps", "web", "dist", "index.html")]
  .map(path => access(path)));
const server = spawn("pnpm", ["--filter", "@opengrok/web", "preview"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, OPENGROK_TLS_KEY: key, OPENGROK_TLS_CERT: cert },
});
process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
server.once("error", error => { console.error(error); process.exitCode = 1; });
server.once("exit", code => { process.exitCode = code ?? 1; });
