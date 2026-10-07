import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const database = process.env.OPENGROK_REAL_EGRESS_DB;
if (process.env.OPENGROK_ALLOW_REAL_EGRESS_TEST !== "1" ||
  !/^opengrok_real_egress_[a-z0-9_]+$/.test(database || "")) {
  throw new Error("Set OPENGROK_ALLOW_REAL_EGRESS_TEST=1 and a fresh OPENGROK_REAL_EGRESS_DB");
}
const dataDir = join(root, ".local", `real-egress-${database.slice("opengrok_real_egress_".length)}`);
const config = Object.fromEntries(readFileSync(join(root, ".local/dev.env"), "utf8")
  .split("\n").filter(Boolean).map(line => {
    const index = line.indexOf("=");
    if (index < 1) throw new Error("Invalid local database configuration");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const databaseUrl = new URL(config.DATABASE_URL);
databaseUrl.pathname = `/${database}`;
const hostToken = readFileSync(join(root, ".local/host.token"), "utf8").trim();
const testPassword = randomBytes(24).toString("base64url");
const env = { ...process.env, ...config, DATABASE_URL: databaseUrl.toString(),
  OPENGROK_DATA_DIR: dataDir, OPENGROK_HOST_TOKEN: hostToken,
  OPENGROK_TEST_PASSWORD: testPassword,
  OPENGROK_HOST_URL: "http://127.0.0.1:3844", OPENGROK_DESKTOP_MANAGED: "0",
  OPENGROK_TEST_PROVIDER: "openai-compatible",
  OPENGROK_TEST_MODEL_ID: "traex/Gemini-3-Flash-Preview" };
const children = new Map();

function command(name, args) {
  const result = spawnSync(name, args, { cwd: root, encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

async function portOpen(port) {
  return new Promise(resolvePort => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolvePort(true); });
    socket.once("error", () => resolvePort(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolvePort(false); });
  });
}

async function waitFor(label, check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function start(name, extra = {}) {
  const file = openSync(join(dataDir, `${name}.log`), "a", 0o600);
  const child = spawn(join(root, "node_modules/.bin/tsx"),
    [join(root, `apps/${name}/src/index.ts`)], { cwd: root, env: { ...env, ...extra },
      detached: true, stdio: ["ignore", file, file] });
  closeSync(file);
  children.set(name, child);
}

async function stopAll() {
  for (const child of [...children.values()].reverse()) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    await Promise.race([new Promise(resolveExit => child.once("exit", resolveExit)), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
}

const bootstrap = await fetch("http://127.0.0.1:3848/api/bootstrap", {
  signal: AbortSignal.timeout(3000),
}).then(response => response.json());
assert.equal(bootstrap.initialized, false, "The managed personal workspace must have no account");
const stateResponse = await fetch("http://127.0.0.1:3842/state", {
  headers: { authorization: `Bearer ${hostToken}` }, signal: AbortSignal.timeout(3000),
});
assert.equal(stateResponse.status, 200);
const { computer } = await stateResponse.json();
assert.equal(computer.status, "ready");
assert.equal(computer.controlMode, "agent");
assert.equal(computer.operationBusy, false);
for (const port of [3841, 3844]) assert.equal(await portOpen(port), false, `Port ${port} is in use`);
command("sudo", ["-n", process.execPath, "scripts/desktop-firewall.mjs", "verify"]);

mkdirSync(dataDir, { mode: 0o700 });
copyFileSync(join(root, ".local/desktop.env"), join(dataDir, "desktop.env"));
command("sudo", ["-n", "docker", "exec", "opengrok-postgres", "sh", "-lc",
  `createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" ${database}`]);

let testStatus = null;
try {
  start("computer-host", { OPENGROK_HOST_PORT: "3844" });
  start("api", { OPENGROK_API_PORT: "3841" });
  await waitFor("isolated Host", async () => {
    const response = await fetch("http://127.0.0.1:3844/health", {
      headers: { authorization: `Bearer ${hostToken}` }, signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  });
  await waitFor("isolated API", async () =>
    (await fetch("http://127.0.0.1:3841/api/health", { signal: AbortSignal.timeout(2000) })).ok);
  const setup = await fetch("http://127.0.0.1:3841/api/setup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "smoke", password: testPassword }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(setup.status, 200, await setup.text());
  start("worker");
  const child = spawn(join(root, "node_modules/.bin/tsx"),
    [join(root, "tests/real-traex-smoke.mts")], { cwd: root, env, stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
  try {
    testStatus = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
  } finally { clearTimeout(timer); }
  assert.equal(testStatus, 0, "Real TraeX Gemini report and memory smoke failed");
  console.log(JSON.stringify({ status: "passed", database, dataDir }));
} finally {
  await stopAll();
  command("sudo", ["-n", "docker", "exec", "opengrok-postgres", "sh", "-lc",
    `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ${database} -c 'UPDATE model_profiles SET encrypted_api_key=NULL'`]);
}
