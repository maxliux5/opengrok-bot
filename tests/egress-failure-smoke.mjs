import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (process.env.OPENGROK_ALLOW_EGRESS_FAILURE_TEST !== "1") {
  throw new Error("Set OPENGROK_ALLOW_EGRESS_FAILURE_TEST=1 after checking the personal workspace is idle");
}

function command(name, args, expectedCode = 0) {
  const result = spawnSync(name, args, { cwd: root, encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  if (expectedCode !== null && result.status !== expectedCode) {
    throw new Error(`${name} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function monitor() {
  const run = command(process.execPath, ["scripts/run-monitor.mjs"], null);
  const output = JSON.parse(run.stdout.trim());
  return { code: run.status, output };
}

async function gatewayHealth(url) {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
  return response.ok && (await response.json()).ok === true;
}

const bootstrap = JSON.parse(command("curl", ["--noproxy", "*", "--silent", "--show-error",
  "--insecure", "https://127.0.0.1:8443/api/bootstrap"]).stdout);
assert.equal(bootstrap.initialized, false, "Only a zero-account personal workspace may run this smoke test");
const hostToken = (await readFile(resolve(root, ".local/host.token"), "utf8")).trim();
const hostResponse = await fetch("http://127.0.0.1:3842/state", {
  headers: { authorization: `Bearer ${hostToken}` }, signal: AbortSignal.timeout(3000),
});
assert.equal(hostResponse.status, 200);
const { computer } = await hostResponse.json();
assert.equal(computer.status, "ready");
assert.equal(computer.controlMode, "agent");
assert.equal(computer.operationBusy, false);

const network = JSON.parse(command("sudo", ["-n", "docker", "network", "inspect", "desktop_default"]).stdout)[0];
const gateway = network.IPAM.Config[0].Gateway;
const port = Number(process.env.OPENGROK_EGRESS_PORT || 3888);
const gatewayUrl = `http://${gateway}:${port}`;
command("sudo", ["-n", process.execPath, "scripts/desktop-firewall.mjs", "verify",
  "desktop_default", String(port)]);
assert.equal(await gatewayHealth(gatewayUrl), true);
assert.equal(monitor().code, 0);

const publicBefore = command("sudo", ["-n", "docker", "exec", "opengrok-desktop", "curl",
  "--silent", "--show-error", "--max-time", "10", "--proxy", gatewayUrl,
  "--output", "/dev/null", "--write-out", "%{http_code}", "https://www.saucedemo.com/"]);
assert.equal(publicBefore.stdout, "200");

let stopped = false;
let evidence;
try {
  command("systemctl", ["--user", "stop", "opengrok-egress.service"]);
  stopped = true;
  const direct = command("sudo", ["-n", "docker", "exec", "opengrok-desktop", "node", "-e",
    "fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('reachable:'+r.status)).catch(e=>console.log('blocked:'+(e.cause?.code||e.name)))"]);
  assert.match(direct.stdout, /^blocked:/);
  const proxied = command("sudo", ["-n", "docker", "exec", "opengrok-desktop", "curl",
    "--silent", "--show-error", "--max-time", "3", "--proxy", gatewayUrl,
    "--output", "/dev/null", "https://www.saucedemo.com/"], null);
  assert.notEqual(proxied.status, 0);
  const during = monitor();
  assert.equal(during.code, 2);
  assert.equal(during.output.issues.some(issue => issue.code === "egressGateway_unavailable"), true);
  assert.equal(during.output.web.status, 200);
  assert.equal(during.output.api.ok, true);
  assert.equal(during.output.host.status, "ready");
  assert.equal(during.output.desktopFirewall.status, "ok");
  evidence = { direct: direct.stdout.trim(), proxyExit: proxied.status,
    monitorStatus: during.output.status, monitorIssue: "egressGateway_unavailable" };
} finally {
  if (stopped) command("systemctl", ["--user", "start", "opengrok-egress.service"]);
}

const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  if (await gatewayHealth(gatewayUrl).catch(() => false)) break;
  await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
}
assert.equal(await gatewayHealth(gatewayUrl), true);
const recovered = monitor();
assert.equal(recovered.code, 0);
assert.equal(recovered.output.status, "ok");
console.log(JSON.stringify({ status: "passed", during: evidence, recovered: recovered.output.status }));
