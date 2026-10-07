import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const id = randomUUID().slice(0, 8);
const database = `opengrok_password_${id}`;
const dataDir = join(root, ".local", `password-web-${id}`);
const httpsTest = process.env.OPENGROK_PASSWORD_HTTPS_TEST === "1";
const setupTokenTest = process.env.OPENGROK_PASSWORD_SETUP_TOKEN_TEST === "1";
const setupTokenFile = join(dataDir, "setup.token");
const setupToken = randomBytes(32).toString("base64url");
const webPort = httpsTest ? 8444 : 5174;
const origin = `${httpsTest ? "https" : "http"}://127.0.0.1:${webPort}`;
const username = `password-smoke-${id}`;
const initialPassword = randomBytes(24).toString("base64url");
const newPassword = randomBytes(24).toString("base64url");
const config = Object.fromEntries(readFileSync(join(root, ".local/dev.env"), "utf8")
  .split("\n").filter(Boolean).map(line => {
    const index = line.indexOf("=");
    if (index < 1) throw new Error("Invalid local database configuration");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
const databaseUrl = new URL(config.DATABASE_URL);
databaseUrl.pathname = `/${database}`;

function command(name, args) {
  const result = spawnSync(name, args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error || result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function portOpen(port) {
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

for (const port of [3841, webPort]) assert.equal(await portOpen(port), false, `Test port ${port} is in use`);
mkdirSync(dataDir, { mode: 0o700 });
if (setupTokenTest) writeFileSync(setupTokenFile, `${setupToken}\n`, { mode: 0o600, flag: "wx" });
command("sudo", ["-n", "docker", "exec", "opengrok-postgres", "sh", "-lc",
  `createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" ${database}`]);
const children = [];
let browser;
function start(label, executable, args, cwd, env) {
  const file = openSync(join(dataDir, `${label}.log`), "a", 0o600);
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ["ignore", file, file] });
  closeSync(file);
  children.push(child);
}

try {
  start("api", join(root, "node_modules/.bin/tsx"), [join(root, "apps/api/src/index.ts")], root,
    { ...process.env, ...config, DATABASE_URL: databaseUrl.toString(), OPENGROK_DATA_DIR: dataDir,
      OPENGROK_API_PORT: "3841", OPENGROK_WEB_ORIGIN: origin,
      OPENGROK_HTTPS: httpsTest ? "1" : "0",
      ...(setupTokenTest ? { OPENGROK_SETUP_TOKEN_FILE: setupTokenFile } : {}) });
  start("web", join(root, "node_modules/.bin/vite"), [...(httpsTest ? ["preview"] : []),
    "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
    join(root, "apps/web"), { ...process.env, OPENGROK_API_TARGET: "http://127.0.0.1:3841",
      ...(httpsTest ? { OPENGROK_TLS_KEY: join(root, ".local/tls/key.pem"),
        OPENGROK_TLS_CERT: join(root, ".local/tls/cert.pem") } : {}) });
  await waitFor("isolated Web API", async () =>
    await portOpen(webPort) &&
    (await fetch("http://127.0.0.1:3841/api/bootstrap", { signal: AbortSignal.timeout(2000) })).ok);
  const setupUrl = "http://127.0.0.1:3841/api/setup";
  const bootstrap = await (await fetch("http://127.0.0.1:3841/api/bootstrap")).json();
  assert.equal(bootstrap.initialized, false);
  assert.equal(bootstrap.setupTokenRequired, setupTokenTest);
  if (setupTokenTest) {
    for (const candidate of [undefined, "wrong-token"]) {
      const denied = await fetch(setupUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: initialPassword, setupToken: candidate }) });
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).code, "invalid_setup_token");
      assert.equal((await (await fetch("http://127.0.0.1:3841/api/bootstrap")).json()).initialized, false);
    }
    const hiddenTokenFile = `${setupTokenFile}.hidden`;
    renameSync(setupTokenFile, hiddenTokenFile);
    try {
      const unavailable = await fetch(setupUrl, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password: initialPassword, setupToken }) });
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json()).code, "setup_unavailable");
      assert.equal((await (await fetch("http://127.0.0.1:3841/api/bootstrap")).json()).initialized, false);
    } finally { renameSync(hiddenTokenFile, setupTokenFile); }
  }

  browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
  const first = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: httpsTest,
    viewport: { width: 1280, height: 800 } });
  const second = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: httpsTest });
  const third = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: httpsTest });
  const page = await first.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("/");
  await page.getByLabel("用户名").waitFor();
  if (setupTokenTest) await page.getByLabel("初始化口令").waitFor();
  assert.equal(await page.getByLabel("初始化口令").count(), setupTokenTest ? 1 : 0);
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(initialPassword);
  if (setupTokenTest) await page.getByLabel("初始化口令").fill(setupToken);
  await page.getByRole("button", { name: "创建空间" }).click();
  await page.getByTitle("修改密码").waitFor();
  if (setupTokenTest) {
    assert.equal(existsSync(setupTokenFile), false);
    const reused = await fetch(setupUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: `${username}-other`, password: initialPassword, setupToken }) });
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).code, "already_initialized");
  }

  const secondLogin = await second.request.post("/api/login", {
    data: { username, password: initialPassword } });
  assert.equal(secondLogin.status(), 200);
  const loginCookie = secondLogin.headers()["set-cookie"];
  assert.match(loginCookie, /HttpOnly/i);
  assert.match(loginCookie, /SameSite=Lax/i);
  assert.equal(/(?:^|;)\s*Secure(?:;|$)/i.test(loginCookie), httpsTest);
  assert.equal((await third.request.post("/api/account/password", {
    data: { currentPassword: initialPassword, newPassword },
  })).status(), 401);
  assert.equal((await first.request.post("/api/account/password", {
    data: { currentPassword: initialPassword, newPassword: initialPassword },
  })).status(), 400);
  assert.equal((await second.request.get("/api/session")).status(), 200);
  const profile = (await (await first.request.post("/api/model-profiles", { data: {
    name: "Password stream test", provider: "openai-compatible", modelId: "test",
    baseUrl: "http://127.0.0.1:3850/v1",
  } })).json()).profile;
  const bot = (await (await first.request.post("/api/bots", { data: {
    name: "会话撤销测试", description: "", instructions: "", modelProfileId: profile.id,
  } })).json()).bot;
  const conversation = (await (await first.request.post(`/api/bots/${bot.id}/conversations`, {
    data: {},
  })).json()).conversation;
  const submitted = (await (await first.request.post(
    `/api/conversations/${conversation.id}/messages`, { data: {
      text: "等待会话撤销测试", requestId: randomUUID(), deliverable: "answer",
    } })).json()).run;
  const secondCookie = (await second.cookies(origin)).find(item => item.name === "opengrok_session");
  assert.ok(secondCookie);
  const stream = await fetch(`http://127.0.0.1:3841/api/runs/${submitted.id}/events`, {
    headers: { cookie: `opengrok_session=${secondCookie.value}` },
  });
  assert.equal(stream.status, 200);
  assert.ok(stream.body);
  const streamReader = stream.body.getReader();
  assert.equal((await streamReader.read()).done, false);
  await page.getByTitle("修改密码").click();
  const dialog = page.getByRole("dialog", { name: "修改密码" });
  await dialog.getByLabel("当前密码").fill("incorrect-password");
  await dialog.getByLabel("新密码", { exact: true }).fill(newPassword);
  await dialog.getByLabel("确认新密码").fill(newPassword);
  const desktopScreenshot = join(dataDir, "password-desktop.png");
  await page.screenshot({ path: desktopScreenshot });
  await dialog.getByRole("button", { name: "更新密码" }).click();
  await dialog.getByText("当前密码错误").waitFor();
  assert.equal((await second.request.get("/api/session")).status(), 200);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileScreenshot = join(dataDir, "password-mobile.png");
  await page.screenshot({ path: mobileScreenshot });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await dialog.getByLabel("当前密码").fill(initialPassword);
  await dialog.getByRole("button", { name: "更新密码" }).click();
  await page.getByText("密码已更新，其他登录会话已退出").waitFor();
  const rotatedCookie = (await first.cookies(origin)).find(item => item.name === "opengrok_session");
  assert.equal(rotatedCookie?.secure, httpsTest);
  assert.equal(rotatedCookie?.httpOnly, true);
  assert.equal(rotatedCookie?.sameSite, "Lax");
  const streamClosed = await Promise.race([
    (async () => { while (!(await streamReader.read()).done) { /* drain buffered events */ } return true; })(),
    delay(5000).then(() => false),
  ]);
  assert.equal(streamClosed, true);

  assert.equal((await first.request.get("/api/session")).status(), 200);
  assert.equal((await second.request.get("/api/session")).status(), 401);
  assert.equal((await third.request.post("/api/login", {
    data: { username, password: initialPassword } })).status(), 401);
  assert.equal((await third.request.post("/api/login", {
    data: { username, password: newPassword } })).status(), 200);
  assert.equal((await first.request.post(`/api/runs/${submitted.id}/cancel`, { data: {} })).status(), 200);
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: "passed", database, https: httpsTest,
    setupTokenRequired: setupTokenTest,
    secureCookie: httpsTest, secondSessionRevoked: true,
    unauthenticatedDenied: true, samePasswordDenied: true, oldPasswordRejected: true,
    newPasswordAccepted: true, eventStreamClosed: true, mobileOverflow: false,
    desktopScreenshot, mobileScreenshot }));
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    await Promise.race([new Promise(resolveExit => child.once("exit", resolveExit)), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
}
