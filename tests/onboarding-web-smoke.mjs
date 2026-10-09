import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { startOnboardingModel } from "./fake-onboarding-model.mjs";

const root = resolve(import.meta.dirname, "..");
const suffix = randomUUID().slice(0, 8);
const database = `opengrok_onboarding_${suffix}`;
const container = `opengrok-onboarding-${suffix}`;
const dataDir = join(root, ".local", `onboarding-${suffix}`);
const origin = "https://127.0.0.1:8444";
const apiUrl = "http://127.0.0.1:3841";
const runtimeUrl = "http://127.0.0.1:3845";
const realModel = process.env.OPENGROK_ONBOARDING_REAL_MODEL;
const password = randomBytes(24).toString("base64url");
const setupToken = randomBytes(32).toString("base64url");
const runtimeToken = randomBytes(32).toString("base64url");
const config = Object.fromEntries(readFileSync(join(root, ".local/dev.env"), "utf8")
  .split("\n").filter(Boolean).map(line => {
    const index = line.indexOf("=");
    if (index < 1) throw new Error("Invalid local configuration");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const databaseUrl = new URL(config.DATABASE_URL);
databaseUrl.pathname = `/${database}`;
const env = { ...process.env, ...config, DATABASE_URL: databaseUrl.toString(), OPENGROK_DATA_DIR: dataDir,
  OPENGROK_HOST_TOKEN: randomBytes(32).toString("base64url"), OPENGROK_HOST_URL: "http://127.0.0.1:3844",
  OPENGROK_RUNTIME_URL: runtimeUrl, OPENGROK_VNC_PORT: "6081", OPENGROK_VNC_WS_URL: "ws://127.0.0.1:6081",
  OPENGROK_DESKTOP_MANAGED: "0", OPENGROK_API_PORT: "3841", OPENGROK_HOST_PORT: "3844",
  OPENGROK_HTTPS: "1", OPENGROK_WEB_ORIGIN: origin,
  OPENGROK_SETUP_TOKEN_FILE: join(dataDir, "setup.token") };
const children = new Map();
let browser;
let model;
let containerStarted = false;
let databaseCreated = false;

function command(name, args, timeout = 30_000) {
  const result = spawnSync(name, args, { cwd: root, encoding: "utf8", timeout });
  if (result.error || result.status !== 0) throw new Error(`${name} failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
}
function sql(statement) {
  return command("sudo", ["-n", "docker", "exec", "opengrok-postgres", "sh", "-lc",
    `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ${database} -At -c "$1"`, "sh", statement]);
}
async function portOpen(port) {
  return new Promise(resolvePort => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = result => { socket.destroy(); resolvePort(result); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
async function waitFor(label, check, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
function start(name, executable, args, cwd = root, extra = {}) {
  const file = openSync(join(dataDir, `${name}.log`), "a", 0o600);
  const child = spawn(executable, args, { cwd, env: { ...env, ...extra }, detached: true,
    stdio: ["ignore", file, file] });
  closeSync(file); children.set(name, child);
}
function service(name, directory = name) {
  start(name, join(root, "node_modules/.bin/tsx"), [join(root, `apps/${directory}/src/index.ts`)]);
}
async function stop(name) {
  const child = children.get(name);
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  await Promise.race([new Promise(resolveExit => child.once("exit", resolveExit)), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid, "SIGKILL");
    await new Promise(resolveExit => child.once("exit", resolveExit));
  }
}
async function runtime(path, body) {
  const response = await fetch(`${runtimeUrl}${path}`, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${runtimeToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  return { status: response.status, data: await response.json() };
}

try {
  for (const port of [3841, 3844, 3845, 6081, 8444]) assert.equal(await portOpen(port), false, `Port ${port} is occupied`);
  command("sudo", ["-n", process.execPath, "scripts/desktop-firewall.mjs", "verify", "desktop_default", "3888"]);
  mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(env.OPENGROK_SETUP_TOKEN_FILE, setupToken, { mode: 0o600, flag: "wx" });
  writeFileSync(join(dataDir, "desktop.env"), `OPENGROK_RUNTIME_TOKEN=${runtimeToken}\n`, { mode: 0o600, flag: "wx" });
  command("sudo", ["-n", "docker", "exec", "opengrok-postgres", "sh", "-lc",
    `createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" ${database}`]);
  databaseCreated = true;
  command("sudo", ["-n", "docker", "run", "-d", "--name", container, "--network", "desktop_default",
    "--restart", "no", "--init", "--shm-size", "1g", "--cap-drop", "NET_RAW",
    "--security-opt", "no-new-privileges:true", "--security-opt", `seccomp=${join(root, "infra/desktop/seccomp_profile.json")}`,
    "--env-file", join(dataDir, "desktop.env"), "-e", "OPENGROK_BROWSER_PROXY=gateway", "-e", "OPENGROK_EGRESS_PORT=3888",
    "-p", "127.0.0.1:3845:3843", "-p", "127.0.0.1:6081:6080", "opengrok-desktop:0.1.0"]);
  containerStarted = true;
  await waitFor("isolated desktop", async () => (await runtime("/health")).data.ready, 60_000);
  model = await startOnboardingModel();
  service("api"); service("host", "computer-host");
  start("web", join(root, "node_modules/.bin/vite"), ["preview", "--host", "127.0.0.1", "--port", "8444", "--strictPort"],
    join(root, "apps/web"), { OPENGROK_API_TARGET: apiUrl, OPENGROK_TLS_KEY: join(root, ".local/tls/key.pem"),
      OPENGROK_TLS_CERT: join(root, ".local/tls/cert.pem") });
  await waitFor("isolated API", async () => (await fetch(`${apiUrl}/api/bootstrap`)).ok);
  await waitFor("isolated Web", () => portOpen(8444));
  for (const path of ["/onboarding/diagnostics", "/model-profiles/test", `/model-profiles/${randomUUID()}/test`]) {
    assert.equal((await fetch(`${apiUrl}/api${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  }
  assert.equal(model.requests.length, 0);
  browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
  const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("用户名").fill("onboarding-demo");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("初始化口令").fill(setupToken);
  await page.getByRole("button", { name: "创建空间" }).click();
  const wizard = page.getByRole("region", { name: "首次使用向导" });
  await wizard.getByText("20 秒内没有执行器心跳，请启动 Worker 服务").waitFor();
  service("worker");
  await waitFor("worker heartbeat", async () => {
    const result = await (await context.request.post("/api/onboarding/diagnostics", { data: {} })).json();
    return result.checks.find(check => check.id === "workers").status === "ok";
  });
  await wizard.getByTitle("重新检查环境").click();
  await wizard.getByText("1 个执行器在线").waitFor();
  console.log("Environment diagnostics: missing Worker and recovery verified");
  await page.screenshot({ path: join(dataDir, "environment-desktop.png"), animations: "disabled" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(dataDir, `environment-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const draft = { name: "Probe", provider: "openai-compatible", modelId: "probe", baseUrl: model.baseUrl,
    apiKey: "fixture-secret", capabilities: { text: true, tools: true, vision: false, streaming: true } };
  for (const provider of ["openai-compatible", "anthropic"]) {
    for (const streaming of [false, true]) {
      const result = await (await context.request.post("/api/model-profiles/test", { data: { ...draft, provider,
        capabilities: { ...draft.capabilities, streaming } } })).json();
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.checks.find(check => check.id === "vision").status, "unchecked");
    }
  }
  const textOnly = await (await context.request.post("/api/model-profiles/test", { data: {
    ...draft, capabilities: { ...draft.capabilities, tools: false } } })).json();
  assert.equal(textOnly.ok, true);
  assert.equal(textOnly.checks.find(check => check.id === "tools").status, "unchecked");
  const missingTool = await (await context.request.post("/api/model-profiles/test", { data: { ...draft, modelId: "bad-tool" } })).json();
  assert.equal(missingTool.ok, false);
  const pending = context.request.post("/api/model-profiles/test", { data: { ...draft, modelId: "slow" } });
  await waitFor("slow probe request", async () => model.requests.some(item => item.model === "slow"));
  assert.equal((await context.request.post("/api/model-profiles/test", { data: draft })).status(), 409);
  assert.equal((await (await pending).json()).ok, true);
  const timedOut = await (await context.request.post("/api/model-profiles/test", { data: { ...draft, modelId: "timeout" }, timeout: 25_000 })).json();
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.checks[0].detail, /20 秒/);
  assert.equal((await context.request.post("/api/model-profiles/test", { data: draft, headers: { Origin: "https://untrusted.example" } })).status(), 403);
  assert.equal((await context.request.post("/api/model-profiles/test", { data: { ...draft, baseUrl: "http://remote.example/v1" } })).status(), 400);
  assert.equal(sql("SELECT count(*) FROM model_profiles"), "0");
  assert.equal(sql("SELECT count(*) FROM runs"), "0");
  console.log("Model probes: protocols, streaming, errors, timeout, authorization verified");

  await wizard.getByRole("button", { name: "配置模型", exact: true }).click();
  await wizard.getByLabel("模型 ID").fill("probe");
  await wizard.getByLabel("API 地址", { exact: true }).fill(model.baseUrl);
  await wizard.getByLabel("API Key").fill("fixture-secret");
  await wizard.getByRole("button", { name: "测试连接", exact: true }).click();
  await wizard.locator('[data-check="response"].ok').waitFor();
  assert.equal(sql("SELECT count(*) FROM model_profiles"), "0");
  await wizard.getByLabel("模型 ID").fill("denied");
  assert.equal(await wizard.locator('[data-check="response"].ok').count(), 0);
  await wizard.getByRole("button", { name: "测试并保存模型" }).click();
  await wizard.getByText("模型鉴权失败，请检查 API Key 和访问权限").waitFor();
  assert.equal((await wizard.innerText()).includes("private-upstream-detail"), false);
  assert.equal(sql("SELECT count(*) FROM model_profiles"), "0");
  await page.setViewportSize({ width: 320, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(dataDir, "model-error-mobile.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  let connection = { baseUrl: model.baseUrl, apiKey: "fixture-secret" };
  if (realModel) {
    const { loadTestProxyConfig } = await import("./test-proxy-config.mts");
    connection = loadTestProxyConfig();
  }
  await wizard.getByLabel("模型 ID").fill(realModel || "onboarding-fixture");
  await wizard.getByLabel("API 地址", { exact: true }).fill(connection.baseUrl);
  await wizard.getByLabel("API Key").fill(connection.apiKey);
  await wizard.getByRole("button", { name: "测试并保存模型" }).click();
  await wizard.getByRole("heading", { name: "配置 Bot", exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(sql("SELECT count(*) FROM model_profiles"), "1");
  await page.reload();
  await wizard.getByRole("button", { name: "配置模型", exact: true }).click();
  await wizard.getByRole("button", { name: "使用此模型" }).click();
  await wizard.getByRole("button", { name: "保存 Bot", exact: true }).click();
  await wizard.getByRole("heading", { name: "首次任务", exact: true }).waitFor();
  assert.equal(sql("SELECT count(*) FROM bots"), "1");
  await page.screenshot({ path: join(dataDir, "first-task-desktop.png"), animations: "disabled" });
  await wizard.getByRole("button", { name: "生成首份报告" }).click();
  await waitFor("report run", async () => sql("SELECT count(*) FROM runs") === "1");
  const runId = sql("SELECT id FROM runs LIMIT 1");
  let completedRun;
  await waitFor("completed report", async () => {
    const { run } = await (await context.request.get(`/api/runs/${runId}`)).json();
    completedRun = run;
    return ["succeeded", "failed", "canceled"].includes(run.status);
  }, realModel ? 240_000 : 60_000);
  assert.equal(completedRun.status, "succeeded", completedRun.error || "Report did not succeed");
  const { artifacts } = await (await context.request.get(`/api/runs/${runId}/artifacts`)).json();
  const artifact = artifacts.find(item => item.mimeType.startsWith("text/markdown"));
  assert.ok(artifact);
  const contents = await (await context.request.get(`/api/artifacts/${artifact.id}/content`)).body();
  assert.match(contents.toString(), /https:\/\/example\.com\//);
  assert.equal(createHash("sha256").update(contents).digest("hex"), artifact.sha256);
  await page.getByRole("tab", { name: "成果", exact: true }).click();
  await page.locator(".artifact-open").first().click();
  await page.locator(".artifact-markdown").waitFor();
  await page.screenshot({ path: join(dataDir, "report-desktop.png"), animations: "disabled" });
  console.log("First report: published and SHA-256 verified");

  await page.getByRole("tab", { name: "电脑", exact: true }).click();
  await page.getByTitle("展开电脑").click();
  await page.getByText("电脑已连接", { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "接管电脑", exact: true }).click();
  await page.getByRole("button", { name: "归还控制", exact: true }).waitFor({ timeout: 20_000 });
  await page.getByText("电脑已连接", { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal((await runtime("/health")).data.mode, "human");
  assert.equal((await runtime("/operation", { name: "browser_read", args: {}, deadline: Date.now() + 5000 })).status, 409);
  const canvas = page.locator(".novnc-target canvas");
  await waitFor("nonblank desktop", async () => await canvas.evaluate(element => {
    const data = element.getContext("2d").getImageData(0, 0, element.width, element.height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 1600) colors.add(`${data[i]},${data[i+1]},${data[i+2]}`);
    return element.width > 1000 && element.height > 500 && colors.size > 10;
  }));
  await canvas.click({ position: { x: 100, y: 100 } });
  await delay(200);
  await page.keyboard.press("Control+l");
  await delay(200);
  await page.keyboard.type("https://example.org/", { delay: 40 });
  await page.keyboard.press("Enter");
  await waitFor("human browser navigation", async () => (await runtime("/health")).data.url === "https://example.org/", 30_000);
  await page.screenshot({ path: join(dataDir, "computer-takeover.png"), animations: "disabled" });
  await page.getByRole("button", { name: "归还控制", exact: true }).click();
  await page.getByRole("button", { name: "接管电脑", exact: true }).waitFor({ timeout: 20_000 });
  assert.equal((await runtime("/health")).data.mode, "agent");
  const read = await runtime("/operation", { name: "browser_read", args: {}, deadline: Date.now() + 10_000 });
  assert.equal(read.status, 200);
  assert.equal(read.data.url, "https://example.org/");
  await page.getByTitle("收起电脑").click();
  await page.getByTitle("使用向导", { exact: true }).click();
  await wizard.getByRole("button", { name: "配置模型", exact: true }).click();
  await wizard.getByRole("button", { name: "测试当前模型" }).click();
  await wizard.locator('[data-check="response"].ok').waitFor({ timeout: 30_000 });
  const profiles = await (await context.request.get("/api/model-profiles")).json();
  assert.equal(JSON.stringify(profiles).includes(connection.apiKey), false);
  assert.equal((await context.request.post(`/api/model-profiles/${randomUUID()}/test`, { data: {} })).status(), 404);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(dataDir, `model-success-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await wizard.getByTitle("关闭使用向导").click();
  await page.reload();
  assert.equal(await wizard.count(), 0);
  await page.getByTitle("Bot 设置", { exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Bot 设置" });
  await settings.getByRole("button", { name: "模型配置", exact: true }).click();
  await settings.getByLabel("配置名称").fill("Text only");
  await settings.getByLabel("模型 ID").fill("text-only");
  await settings.getByLabel("API 地址", { exact: true }).fill(model.baseUrl);
  await settings.getByLabel("工具调用", { exact: true }).uncheck();
  await settings.getByLabel("流式输出", { exact: true }).uncheck();
  const requestsBeforeSave = model.requests.length;
  await settings.getByRole("button", { name: "保存配置", exact: true }).click();
  await settings.getByRole("button", { name: "保存 Bot", exact: true }).waitFor();
  assert.equal(sql("SELECT count(*) FROM model_profiles"), "2");
  assert.equal(model.requests.length, requestsBeforeSave);
  const textProfile = (await (await context.request.get("/api/model-profiles")).json()).profiles.find(item => item.modelId === "text-only");
  assert.equal(textProfile.capabilities.tools, false);
  assert.equal(textProfile.capabilities.streaming, false);
  await stop("host");
  const degraded = await (await context.request.post("/api/onboarding/diagnostics", { data: {} })).json();
  assert.equal(degraded.checks.find(check => check.id === "computer").status, "error");
  assert.equal(JSON.stringify(degraded).includes(dataDir), false);
  chmodSync(join(dataDir, "artifacts"), 0o500);
  try {
    const storageFailure = await (await context.request.post("/api/onboarding/diagnostics", { data: {} })).json();
    assert.equal(storageFailure.checks.find(check => check.id === "storage").status, "error");
    assert.equal(JSON.stringify(storageFailure).includes(dataDir), false);
  } finally { chmodSync(join(dataDir, "artifacts"), 0o700); }
  const apiLog = readFileSync(join(dataDir, "api.log"), "utf8");
  assert.equal(apiLog.includes("private-upstream-detail"), false);
  assert.equal(apiLog.includes("fixture-secret"), false);
  assert.equal(apiLog.includes(connection.apiKey), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", database, dataDir, realModel: realModel || null,
    authentication: true, originProtection: true, diagnosticFailureAndRecovery: true,
    protocolStreamingMatrix: true, probeTimeoutAndConcurrency: true, noSecretEcho: true,
    onboardingResume: true, reportRunId: runId, artifactId: artifact.id,
    isolatedDesktop: true, canvasNonblank: true, humanNavigation: read.data.url,
    returnedToAgent: true, settingsRegression: true, mobileWidths: [390, 320] }));
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: join(dataDir, "failure.png") }).catch(() => {});
  console.error(`Onboarding test evidence: ${dataDir}`);
  throw error;
} finally {
  if (browser) await browser.close();
  for (const name of [...children.keys()].reverse()) await stop(name);
  if (model) { model.server.closeAllConnections(); await new Promise(resolveClose => model.server.close(resolveClose)); }
  if (containerStarted) command("sudo", ["-n", "docker", "rm", "-f", container]);
  if (databaseCreated && sql("SELECT to_regclass('public.model_profiles')")) {
    sql("UPDATE model_profiles SET encrypted_api_key=NULL");
  }
}
