import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync,
  realpathSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.OPENGROK_ALLOW_ISOLATED_EGRESS_TEST !== "1") {
  throw new Error("Set OPENGROK_ALLOW_ISOLATED_EGRESS_TEST=1 to create a disposable desktop network");
}
const root = resolve(import.meta.dirname, "..");
const id = randomUUID().slice(0, 8);
const networkName = `opengrok_restore_smoke_${id}`;
const containerName = `opengrok-restore-smoke-${id}`;
const chainPrefix = `OG_ISO_${id.toUpperCase()}`;
const token = randomBytes(32).toString("base64url");
const port = 3888;
const proxyFile = join(root, ".local/service-proxy.env");
const proxyLine = (existsSync(proxyFile) ? readFileSync(proxyFile, "utf8") : "")
  .split("\n").find(line => line.startsWith("OPENGROK_BROWSER_PROXY="));
const upstreamProxy = proxyLine?.slice("OPENGROK_BROWSER_PROXY=".length) || "";
const restorePath = process.env.OPENGROK_RESTORE_MANIFEST;
const expectedPath = process.env.OPENGROK_RESTORE_EXPECT_PATH;
const expectedSha256 = process.env.OPENGROK_RESTORE_EXPECT_SHA256;
const agentTest = process.env.OPENGROK_ISOLATED_AGENT_TEST === "1";
const restoredDatabaseTest = process.env.OPENGROK_ISOLATED_RESTORED_DB_TEST === "1";
if (Boolean(expectedPath) !== Boolean(expectedSha256) || expectedPath && !restorePath ||
  expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
  throw new Error("Provide both OPENGROK_RESTORE_EXPECT_PATH and OPENGROK_RESTORE_EXPECT_SHA256");
}
if (agentTest && (!restorePath || !expectedPath)) {
  throw new Error("The isolated Agent test requires a restore manifest and an expected workspace file");
}
if (restoredDatabaseTest && !agentTest) {
  throw new Error("The restored database test requires OPENGROK_ISOLATED_AGENT_TEST=1");
}
let restoreManifest = null;
if (restorePath) {
  const manifestPath = realpathSync(restorePath);
  restoreManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (restoreManifest.targetDir !== dirname(manifestPath) ||
    restoreManifest.status !== "restored_for_isolated_validation") {
    throw new Error("Restore manifest target or status is invalid");
  }
  for (const [label, value] of Object.entries(restoreManifest.desktopVolumes || {})) {
    if (!["home", "workspace"].includes(label) ||
      typeof value !== "string" || !/^opengrok_restore_[a-z0-9_]+_(home|workspace)$/.test(value)) {
      throw new Error("Restore volume name is invalid");
    }
  }
  if (!restoreManifest.desktopVolumes?.home || !restoreManifest.desktopVolumes?.workspace) {
    throw new Error("Restore manifest is missing desktop volumes");
  }
  if (restoredDatabaseTest && !/^opengrok_restore_[a-z0-9_]+$/.test(restoreManifest.database || "")) {
    throw new Error("Restore manifest database name is invalid");
  }
}
let networkCreated = false;
let firewallApplied = false;
let containerCreated = false;
let managedNetwork = false;
let gatewayProcess;
const cloneVolumes = [];
const mountArgs = [];

function command(name, args, expectedCode = 0) {
  const result = spawnSync(name, args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  if (expectedCode !== null && result.status !== expectedCode) {
    throw new Error(`${name} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function waitFor(label, check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => null);
    if (value) return value;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runtime(url, path, body) {
  const response = await fetch(`${url}${path}`, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(50_000) });
  return { status: response.status, data: await response.json() };
}

async function portOpen(port) {
  return new Promise(resolvePort => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolvePort(true); });
    socket.once("error", () => resolvePort(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolvePort(false); });
  });
}

async function runAgentFlow(runtimeUrl, vncAddress) {
  for (const servicePort of [3841, 3844, 3850]) {
    assert.equal(await portOpen(servicePort), false, `Test port ${servicePort} is in use`);
  }
  const database = `opengrok_restore_agent_${id}`;
  const dataDir = join(root, ".local", `restore-agent-${id}`);
  const restoredDir = restoredDatabaseTest ? restoreManifest.targetDir : null;
  const config = Object.fromEntries(readFileSync(restoredDir
    ? join(restoredDir, "restore.env") : join(root, ".local/dev.env"), "utf8")
    .split("\n").filter(Boolean).map(line => {
      const index = line.indexOf("=");
      if (index < 1) throw new Error("Invalid local database configuration");
      return [line.slice(0, index), line.slice(index + 1)];
    }));
  const databaseUrl = new URL(config.DATABASE_URL);
  databaseUrl.pathname = `/${database}`;
  const hostToken = randomBytes(32).toString("base64url");
  const vncPort = Number(vncAddress.split(":")[1]);
  assert.ok(Number.isInteger(vncPort) && vncPort > 0);
  const env = { ...process.env, ...config, DATABASE_URL: databaseUrl.toString(),
    OPENGROK_DATA_DIR: dataDir, OPENGROK_HOST_TOKEN: hostToken,
    OPENGROK_HOST_URL: "http://127.0.0.1:3844", OPENGROK_RUNTIME_URL: runtimeUrl,
    OPENGROK_VNC_PORT: String(vncPort), OPENGROK_VNC_WS_URL: `ws://127.0.0.1:${vncPort}`,
    OPENGROK_DESKTOP_MANAGED: "0" };
  mkdirSync(dataDir, { mode: 0o700 });
  if (restoredDir) {
    cpSync(join(restoredDir, "artifacts"), join(dataDir, "artifacts"), { recursive: true });
    for (const name of ["master.key", "host-journal.sqlite", "host-journal.sqlite-wal"]) {
      if (existsSync(join(restoredDir, name))) copyFileSync(join(restoredDir, name), join(dataDir, name));
    }
  }
  writeFileSync(join(dataDir, "desktop.env"), `OPENGROK_RUNTIME_TOKEN=${token}\n`, { mode: 0o600 });
  command("sudo", ["-n", "docker", "exec", "opengrok-postgres", "sh", "-lc",
    `createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" ${restoredDir
      ? `-T ${restoreManifest.database} ` : ""}${database}`]);
  function sql(statement) {
    return command("sudo", ["-n", "docker", "exec", "opengrok-postgres", "psql",
      "-U", "opengrok", "-d", database, "-Atc", statement]).stdout.trim();
  }
  let restoredOwner = null;
  let historicalArtifact = null;
  let restorePassword = null;
  if (restoredDir) {
    const state = JSON.parse(sql(`SELECT row_to_json(t) FROM (SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM runs WHERE status IN
        ('queued','running','waiting_approval','waiting_user','waiting_computer','verifying')) AS active_runs,
      (SELECT count(*) FROM routines WHERE status='active') AS active_routines,
      (SELECT count(*) FROM artifacts) AS artifacts) t`));
    assert.equal(Number(state.users), 1, "Restored database must have exactly one owner");
    assert.equal(Number(state.active_runs), 0, "Restored database has active Runs");
    assert.equal(Number(state.active_routines), 0, "Restored database has active routines");
    assert.ok(Number(state.artifacts) > 0, "Restored database has no historical artifact");
    restoredOwner = JSON.parse(sql("SELECT row_to_json(t) FROM (SELECT id,username FROM users LIMIT 1) t"));
    historicalArtifact = JSON.parse(sql(`SELECT row_to_json(t) FROM
      (SELECT id,sha256 FROM artifacts ORDER BY created_at LIMIT 1) t`));
    restorePassword = randomBytes(24).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(restorePassword, salt, 64).toString("hex");
    sql(`DELETE FROM sessions; UPDATE users SET password_salt='${salt}',password_hash='${hash}'
      WHERE id='${restoredOwner.id}'`);
  }
  const children = [];
  function start(label, executable, args, extra = {}) {
    const file = openSync(join(dataDir, `${label}.log`), "a", 0o600);
    const child = spawn(executable, args, { cwd: root, env: { ...env, ...extra },
      detached: true, stdio: ["ignore", file, file] });
    closeSync(file);
    children.push(child);
  }
  let cookie = "";
  async function api(path, method = "GET", body) {
    const response = await fetch(`http://127.0.0.1:3841/api${path}`, { method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";", 1)[0];
    const data = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  }
  try {
    start("model", process.execPath, [join(root, "tests/fake-model.mjs")]);
    start("host", join(root, "node_modules/.bin/tsx"), [join(root, "apps/computer-host/src/index.ts")],
      { OPENGROK_HOST_PORT: "3844" });
    start("api", join(root, "node_modules/.bin/tsx"), [join(root, "apps/api/src/index.ts")],
      { OPENGROK_API_PORT: "3841" });
    await waitFor("fake model", async () => await portOpen(3850), 20_000);
    await waitFor("isolated Host", async () => {
      const response = await fetch("http://127.0.0.1:3844/state", {
        headers: { authorization: `Bearer ${hostToken}` }, signal: AbortSignal.timeout(2000) });
      return response.ok && (await response.json()).computer.status === "ready";
    }, 20_000);
    await waitFor("isolated API", async () =>
      (await fetch("http://127.0.0.1:3841/api/health", { signal: AbortSignal.timeout(2000) })).ok,
    20_000);
    if (restoredOwner) {
      await api("/login", "POST", { username: restoredOwner.username, password: restorePassword });
      const { artifact } = await api(`/artifacts/${historicalArtifact.id}`);
      assert.equal(artifact.sha256, historicalArtifact.sha256);
      const historicalContent = await fetch(
        `http://127.0.0.1:3841/api/artifacts/${historicalArtifact.id}/content`,
        { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
      assert.equal(historicalContent.status, 200);
      assert.equal(createHash("sha256").update(Buffer.from(await historicalContent.arrayBuffer()))
        .digest("hex"), historicalArtifact.sha256);
    } else {
      await api("/setup", "POST", { username: "restore-smoke",
        password: randomBytes(24).toString("base64url") });
    }
    const { profile } = await api("/model-profiles", "POST", { name: "Restored desktop test",
      provider: "openai-compatible", modelId: "test-model", baseUrl: "http://127.0.0.1:3850/v1" });
    const { bot } = await api("/bots", "POST", { name: "恢复电脑验收", description: "", instructions: "",
      modelProfileId: profile.id });
    start("worker", join(root, "node_modules/.bin/tsx"), [join(root, "apps/worker/src/index.ts")]);
    const { conversation } = await api(`/bots/${bot.id}/conversations`, "POST", {});
    const { run: submitted } = await api(`/conversations/${conversation.id}/messages`, "POST", {
      text: "在恢复电脑中研究 Example Domain 并发布带来源的报告", requestId: randomUUID(),
      deliverable: "report" });
    const finished = await waitFor("restored desktop Agent Run", async () => {
      const { run } = await api(`/runs/${submitted.id}`);
      return ["succeeded", "failed", "canceled"].includes(run.status) ? run : null;
    }, 90_000);
    assert.equal(finished.status, "succeeded", finished.error || finished.status);
    const { artifacts } = await api(`/runs/${submitted.id}/artifacts`);
    assert.equal(artifacts.length, 1);
    const content = await fetch(`http://127.0.0.1:3841/api/artifacts/${artifacts[0].id}/content`,
      { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
    assert.equal(content.status, 200);
    assert.match(await content.text(), /https:\/\/example\.com\//);
    const current = await runtime(runtimeUrl, "/health");
    assert.equal(current.status, 200);
    assert.match(current.data.url, /^https:\/\/example\.com\/?$/);
    return { database, sourceDatabase: restoredDatabaseTest ? restoreManifest.database : null,
      historicalArtifactId: historicalArtifact?.id || null, runId: submitted.id,
      artifactId: artifacts[0].id, desktopUrl: current.data.url };
  } finally {
    for (const child of children.reverse()) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      await Promise.race([new Promise(resolveExit => child.once("exit", resolveExit)), delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }
  }
}

try {
  managedNetwork = command("sudo", ["-n", "docker", "network", "inspect", "desktop_default"], null).status === 0;
  if (managedNetwork) command("sudo", ["-n", process.execPath, "scripts/desktop-firewall.mjs",
    "verify", "desktop_default", String(port)]);
  command("sudo", ["-n", "docker", "network", "create", "--driver", "bridge", networkName]);
  networkCreated = true;
  const network = JSON.parse(command("sudo", ["-n", "docker", "network", "inspect", networkName]).stdout)[0];
  assert.equal(network.Driver, "bridge");
  assert.equal(network.EnableIPv6, false);
  const gatewayHost = network.IPAM.Config[0].Gateway;
  if (restoreManifest) {
    for (const [label, target] of [["home", "/home/muse"], ["workspace", "/workspace"]]) {
      const source = restoreManifest.desktopVolumes[label];
      command("sudo", ["-n", "docker", "volume", "inspect", source]);
      const clone = `${networkName}_${label}`;
      command("sudo", ["-n", "docker", "volume", "create", clone]);
      cloneVolumes.push(clone);
      command("sudo", ["-n", "docker", "run", "--rm", "--network", "none", "--user", "0",
        "--entrypoint", "sh", "-v", `${source}:/source:ro`, "-v", `${clone}:/target`,
        "opengrok-desktop:0.1.0", "-c", "cp -a /source/. /target/"]);
      mountArgs.push("-v", `${clone}:${target}`);
    }
  }
  command("sudo", ["-n", process.execPath, "scripts/desktop-firewall.mjs", "apply",
    networkName, String(port), chainPrefix]);
  firewallApplied = true;
  if (managedNetwork) command("sudo", ["-n", process.execPath, "scripts/desktop-firewall.mjs",
    "verify", "desktop_default", String(port)]);
  gatewayProcess = spawn(process.execPath, [join(root, "scripts/start-egress.mjs")], {
    cwd: root, env: { ...process.env, OPENGROK_EGRESS_NETWORK: networkName,
      OPENGROK_EGRESS_PORT: String(port), OPENGROK_BROWSER_PROXY: upstreamProxy },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let gatewayOutput = "";
  gatewayProcess.stdout.on("data", chunk => { gatewayOutput += chunk; });
  gatewayProcess.stderr.on("data", chunk => { gatewayOutput += chunk; });
  await waitFor("isolated gateway", async () => {
    const response = await fetch(`http://${gatewayHost}:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).ok === true;
  }, 10_000).catch(error => { throw new Error(`${error.message}: ${gatewayOutput}`); });

  command("sudo", ["-n", "docker", "run", "-d", "--name", containerName,
    "--network", networkName, "--restart", "no", "--init", "--shm-size", "1g",
    "--cap-drop", "NET_RAW", "--security-opt", "no-new-privileges:true",
    "--security-opt", `seccomp=${join(root, "infra/desktop/seccomp_profile.json")}`,
    "-p", "127.0.0.1::3843", "-p", "127.0.0.1::6080",
    ...mountArgs,
    "-e", `OPENGROK_RUNTIME_TOKEN=${token}`, "-e", "OPENGROK_BROWSER_PROXY=gateway",
    "-e", `OPENGROK_EGRESS_PORT=${port}`, "opengrok-desktop:0.1.0"]);
  containerCreated = true;
  const address = command("sudo", ["-n", "docker", "port", containerName, "3843/tcp"]).stdout.trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const runtimeUrl = `http://${address}`;
  const health = await waitFor("isolated desktop", async () => {
    const result = await runtime(runtimeUrl, "/health");
    return result.status === 200 && result.data.ready ? result.data : null;
  });
  assert.equal(health.mode, "agent");
  let restoredWorkspaceSha256 = null;
  if (restoreManifest && expectedPath) {
    const file = await runtime(runtimeUrl, "/operation", { name: "workspace_read",
      args: { path: expectedPath }, operationId: randomUUID(), deadline: Date.now() + 30_000 });
    assert.equal(file.status, 200, JSON.stringify(file.data));
    assert.equal(file.data.sha256, expectedSha256);
    restoredWorkspaceSha256 = file.data.sha256;
  }

  const open = await runtime(runtimeUrl, "/operation", { name: "browser_open",
    args: { url: "https://www.saucedemo.com/" }, operationId: randomUUID(),
    deadline: Date.now() + 60_000 });
  assert.equal(open.status, 200, JSON.stringify(open.data));
  assert.equal(open.data.title, "Swag Labs");
  const read = await runtime(runtimeUrl, "/operation", { name: "browser_read", args: {},
    operationId: randomUUID(), deadline: Date.now() + 30_000 });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.match(read.data.text, /Swag Labs/);
  const direct = command("sudo", ["-n", "docker", "exec", containerName, "node", "-e",
    "fetch('https://example.com',{signal:AbortSignal.timeout(3000)}).then(r=>console.log('reachable:'+r.status)).catch(e=>console.log('blocked:'+(e.cause?.code||e.name)))"]);
  assert.match(direct.stdout, /^blocked:(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)/);
  const publicHttp = command("sudo", ["-n", "docker", "exec", containerName, "curl",
    "--silent", "--show-error", "--max-time", "10", "--proxy", `http://${gatewayHost}:${port}`,
    "--output", "/dev/null", "--write-out", "%{http_code}", "http://example.com/"]);
  assert.equal(publicHttp.stdout, "200");
  const privateTarget = command("sudo", ["-n", "docker", "exec", containerName, "curl",
    "--silent", "--show-error", "--max-time", "5", "--proxy", `http://${gatewayHost}:${port}`,
    "--output", "/dev/null", "--write-out", "%{http_code}", "http://169.254.169.254/"]);
  assert.equal(privateTarget.stdout, "403");
  const vncAddress = command("sudo", ["-n", "docker", "port", containerName, "6080/tcp"]).stdout.trim();
  assert.match(vncAddress, /^127\.0\.0\.1:\d+$/);
  const agent = agentTest ? await runAgentFlow(runtimeUrl, vncAddress) : null;
  console.log(JSON.stringify({ status: "passed", network: networkName, browserTitle: open.data.title,
    direct: direct.stdout.trim(), publicHttp: Number(publicHttp.stdout),
    privateHttp: Number(privateTarget.stdout), managedFirewallVerified: managedNetwork,
    runtimePublished: address, restoreSnapshotId: restoreManifest?.snapshotId || null,
    restoredWorkspaceSha256, agent }));
} finally {
  if (containerCreated) command("sudo", ["-n", "docker", "rm", "-f", containerName]);
  if (gatewayProcess && gatewayProcess.exitCode === null && gatewayProcess.signalCode === null) {
    gatewayProcess.kill("SIGTERM");
    await Promise.race([new Promise(resolveExit => gatewayProcess.once("exit", resolveExit)), delay(5000)]);
    if (gatewayProcess.exitCode === null) gatewayProcess.kill("SIGKILL");
  }
  if (firewallApplied) command("sudo", ["-n", process.execPath, "scripts/desktop-firewall.mjs",
    "remove", networkName, String(port), chainPrefix]);
  if (networkCreated) command("sudo", ["-n", "docker", "network", "rm", networkName]);
  for (const volume of cloneVolumes) command("sudo", ["-n", "docker", "volume", "rm", volume]);
  if (managedNetwork) command("sudo", ["-n", process.execPath, "scripts/desktop-firewall.mjs",
    "verify", "desktop_default", String(port)]);
}
