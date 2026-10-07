import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const home = homedir();
const unitDir = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "systemd/user");
const proxyEnv = join(root, ".local/service-proxy.env");
const devEnv = join(root, ".local/dev.env");
const githubEnv = join(root, ".local/github.env");
const cert = join(root, ".local/tls/cert.pem");
const setupTokenFile = join(root, ".local/setup.token");
const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
const path = `${dirname(process.execPath)}:${dirname(pnpm)}:/usr/bin:/bin`;
const marker = "# Managed by opengrok-bot/scripts/install-user-services.mjs\n";
const replace = process.argv.includes("--replace");
const replaceProxy = process.argv.includes("--replace-proxy");
const dryRun = process.argv.includes("--dry-run");

if (process.argv.slice(2).some(arg => !["--replace", "--replace-proxy", "--dry-run"].includes(arg))) {
  throw new Error("Usage: node scripts/install-user-services.mjs [--dry-run] [--replace] [--replace-proxy]");
}
for (const value of [root, home, unitDir, pnpm, process.execPath]) {
  if (/[\s"\r\n]/.test(value)) throw new Error(`Unsupported systemd path: ${value}`);
}
await Promise.all([devEnv, cert, join(root, ".local/tls/key.pem"),
  join(root, "apps/web/dist/index.html")].map(file => access(file, constants.R_OK)));

function service(description, command, environment = [], needsContainers = true, optionalEnvFiles = []) {
  return `${marker}[Unit]
Description=${description}
${needsContainers ? "Requires=opengrok-containers.service\nAfter=opengrok-containers.service\n" : "After=network-online.target\n"}StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${root}
EnvironmentFile=${devEnv}
EnvironmentFile=-${proxyEnv}
${optionalEnvFiles.map(file => `EnvironmentFile=-${file}\n`).join("")}Environment=PATH=${path}
${environment.map(line => `Environment=${line}\n`).join("")}ExecStart=${command}
Restart=always
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

const files = {
  "opengrok-network.service": `${marker}[Unit]
Description=Prepare OpenGrok desktop network policy
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${root}
EnvironmentFile=-${proxyEnv}
Environment=PATH=${path}
ExecStart=${process.execPath} ${join(root, "scripts/prepare-desktop-network.mjs")}
Restart=on-failure
RestartSec=10
TimeoutStartSec=90

[Install]
WantedBy=default.target
`,
  "opengrok-egress.service": `${marker}[Unit]
Description=OpenGrok public web egress gateway
Wants=opengrok-network.service
After=opengrok-network.service
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${root}
EnvironmentFile=-${proxyEnv}
Environment=PATH=${path}
ExecStart=${process.execPath} ${join(root, "scripts/start-egress.mjs")}
Restart=always
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=default.target
`,
  "opengrok-containers.service": `${marker}[Unit]
Description=OpenGrok PostgreSQL and desktop containers
Wants=opengrok-egress.service
After=opengrok-egress.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${root}
EnvironmentFile=-${proxyEnv}
Environment=PATH=${path}
ExecStart=${process.execPath} ${join(root, "scripts/start-containers.mjs")}
Restart=on-failure
RestartSec=10
TimeoutStartSec=330

[Install]
WantedBy=default.target
`,
  "opengrok-host.service": service("OpenGrok computer host", `${pnpm} dev:host`),
  "opengrok-api.service": service("OpenGrok authenticated API", `${pnpm} dev:api`, [
    "OPENGROK_API_PORT=3848", "OPENGROK_HTTPS=1",
    "OPENGROK_WEB_ORIGIN=https://127.0.0.1:8443",
    `OPENGROK_SETUP_TOKEN_FILE=${setupTokenFile}`,
  ], true, [githubEnv]),
  "opengrok-worker.service": service("OpenGrok run worker", `${pnpm} dev:worker`, [], true, [githubEnv]),
  "opengrok-worker-2.service": service("OpenGrok second run worker", `${pnpm} dev:worker`, [], true, [githubEnv]),
  "opengrok-web.service": service("OpenGrok local HTTPS web", `${pnpm} serve:web`, [
    "OPENGROK_API_TARGET=http://127.0.0.1:3848",
  ]),
  "opengrok-monitor.service": `${marker}[Unit]
Description=Check OpenGrok local deployment
After=opengrok-web.service opengrok-worker.service opengrok-worker-2.service opengrok-host.service

[Service]
Type=oneshot
WorkingDirectory=${root}
EnvironmentFile=${devEnv}
EnvironmentFile=-${proxyEnv}
Environment=PATH=${path}
Environment=NODE_EXTRA_CA_CERTS=${cert}
Environment=OPENGROK_MONITOR_WEB_URL=https://127.0.0.1:8443/
Environment=OPENGROK_MONITOR_API_URL=http://127.0.0.1:3848/api/health
Environment=OPENGROK_MIN_WORKERS=2
ExecStart=${pnpm} monitor
TimeoutStartSec=30
`,
  "opengrok-monitor.timer": `${marker}[Unit]
Description=Check OpenGrok every minute

[Timer]
OnCalendar=*:0/1
Persistent=true
AccuracySec=10s
Unit=opengrok-monitor.service

[Install]
WantedBy=timers.target
`,
};

const proxyValues = Object.fromEntries([
  "OPENGROK_BROWSER_PROXY", "OPENGROK_EGRESS_PORT", "http_proxy", "https_proxy", "no_proxy",
].map(name => [name, process.env[name] || ""]).filter(([, value]) => value));
for (const [name, value] of Object.entries(proxyValues)) {
  if (/[\s"'\r\n]/.test(value)) throw new Error(`${name} cannot be written to a systemd EnvironmentFile`);
}
const proxyContent = Object.entries(proxyValues).map(([name, value]) => `${name}=${value}\n`).join("");

await mkdir(unitDir, { recursive: true, mode: 0o700 });
const previousApiUnit = await readFile(join(unitDir, "opengrok-api.service"), "utf8").catch(error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const createSetupToken = !previousApiUnit?.includes("OPENGROK_SETUP_TOKEN_FILE=");
const existingProxy = await readFile(proxyEnv, "utf8").catch(error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (replaceProxy && !proxyContent) throw new Error("--replace-proxy requires explicit proxy environment values");
for (const [name, content] of Object.entries(files)) {
  const current = await readFile(join(unitDir, name), "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (current !== null && current !== content && (!replace || !current.startsWith(marker))) {
    throw new Error(`${name} differs; inspect it and pass --replace for managed units`);
  }
}
if (dryRun) {
  console.log(JSON.stringify({ unitDir, units: Object.keys(files),
    setupTokenWillCreate: createSetupToken && !(await lstat(setupTokenFile).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    })),
    proxyConfigured: Boolean(existingProxy || proxyContent), proxyWillChange: Boolean(proxyContent &&
      (existingProxy === null || replaceProxy && existingProxy !== proxyContent)) }));
  process.exit(0);
}
if (createSetupToken) {
  try { await writeFile(setupTokenFile, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
const tokenInfo = await lstat(setupTokenFile).catch(error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (tokenInfo && (!tokenInfo.isFile() || tokenInfo.mode & 0o077)) {
  throw new Error("Setup token file must be a private regular file (0600)");
}
if (proxyContent && (existingProxy === null || replaceProxy && existingProxy !== proxyContent)) {
  const temporary = `${proxyEnv}.${process.pid}.tmp`;
  await writeFile(temporary, proxyContent, { mode: 0o600, flag: "wx" });
  await rename(temporary, proxyEnv);
}
for (const [name, content] of Object.entries(files)) {
  const target = join(unitDir, name);
  const current = await readFile(target, "utf8").catch(() => null);
  if (current === content) continue;
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o644, flag: "wx" });
  await rename(temporary, target);
}
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
console.log(JSON.stringify({ unitDir, units: Object.keys(files),
  proxyConfigured: Boolean(existingProxy || proxyContent) }));
