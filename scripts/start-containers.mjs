import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dockerConfig = resolve(homedir(), ".docker");
const environment = [
  `DOCKER_CONFIG=${dockerConfig}`,
  `OPENGROK_EGRESS_PORT=${process.env.OPENGROK_EGRESS_PORT || "3888"}`,
  `http_proxy=${process.env.http_proxy || ""}`,
  `https_proxy=${process.env.https_proxy || ""}`,
  `no_proxy=${process.env.no_proxy || ""}`,
];

async function compose(file) {
  const args = ["-n", "env", ...environment, "docker", "compose", "-f", file,
    "up", "-d", "--no-build", "--wait"];
  const child = spawn("sudo", args, { cwd: root, stdio: "inherit" });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 300_000);
  try {
    const code = await new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("exit", resolveCode);
    });
    if (code !== 0) throw new Error(`${file} failed with exit code ${code}`);
  } finally {
    clearTimeout(timeout);
  }
}

await compose(resolve(root, "infra/control/compose.yaml"));
const network = JSON.parse(await new Promise((resolveOutput, reject) => {
  const child = spawn("sudo", ["-n", "docker", "network", "inspect", "desktop_default"],
    { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolveOutput(output) : reject(new Error("Desktop network missing")));
}))[0];
const gateway = network?.IPAM?.Config?.[0]?.Gateway;
const port = Number(process.env.OPENGROK_EGRESS_PORT || 3888);
if (!gateway || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Desktop egress gateway is unavailable");
}
const firewall = spawn("sudo", ["-n", process.execPath,
  resolve(root, "scripts/desktop-firewall.mjs"), "verify", "desktop_default", String(port)],
{ cwd: root, stdio: "inherit" });
const firewallCode = await new Promise((resolveCode, reject) => {
  firewall.once("error", reject);
  firewall.once("exit", resolveCode);
});
if (firewallCode !== 0) throw new Error("Desktop firewall is not active");
const health = await fetch(`http://${gateway}:${port}/health`, { signal: AbortSignal.timeout(3000) });
if (!health.ok || (await health.json()).ok !== true) throw new Error("Desktop egress gateway is not ready");
await compose(resolve(root, "infra/desktop/compose.yaml"));
