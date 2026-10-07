import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const compose = resolve(root, "infra/desktop/compose.yaml");
const port = process.env.OPENGROK_EGRESS_PORT || "3888";

async function run(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit" });
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("exit", resolveCode);
  });
  if (code !== 0) throw new Error(`${command} exited with ${code}`);
}

await run("sudo", ["-n", "env", `DOCKER_CONFIG=${resolve(homedir(), ".docker")}`,
  "docker", "compose", "-f", compose, "create", "--no-build", "--no-recreate", "desktop"]);
await run("sudo", ["-n", process.execPath, resolve(root, "scripts/desktop-firewall.mjs"),
  "apply", "desktop_default", port]);
