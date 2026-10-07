import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { installNetworkPolicy, publicUrl } from "./network-policy.mjs";
import { WorkspaceFileError, listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from "./workspace-files.mjs";

const exec = promisify(execFile);
const token = process.env.OPENGROK_RUNTIME_TOKEN;
if (!token) throw new Error("Missing runtime token");
const workspace = "/workspace";
const sessionId = randomUUID();
await mkdir(workspace, { recursive: true });
const configuredProxy = process.env.OPENGROK_BROWSER_PROXY?.trim();
let browserProxy = configuredProxy;
if (configuredProxy === "gateway") {
  const routes = (await readFile("/proc/net/route", "utf8")).trim().split("\n").slice(1);
  const route = routes.map(line => line.trim().split(/\s+/)).find(fields =>
    fields[1] === "00000000" && (Number.parseInt(fields[3], 16) & 2) !== 0);
  const gateway = route?.[2];
  const port = Number(process.env.OPENGROK_EGRESS_PORT || 3888);
  if (!gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway) ||
    !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Docker gateway or egress port is unavailable");
  }
  const address = [6, 4, 2, 0].map(offset => Number.parseInt(gateway.slice(offset, offset + 2), 16)).join(".");
  browserProxy = `http://${address}:${port}`;
}
if (browserProxy) {
  const url = new URL(browserProxy);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid browser proxy URL");
}
const context = await chromium.launchPersistentContext("/home/muse/profile", {
  headless: false,
  viewport: { width: 1360, height: 760 },
  args: ["--disable-dev-shm-usage"],
  chromiumSandbox: true,
  // Request routes cannot inspect fetches handled by a Service Worker.
  serviceWorkers: "block",
  ...(browserProxy ? { proxy: { server: browserProxy } } : {}),
});
await installNetworkPolicy(context);
let page = context.pages()[0] || await context.newPage();
let mode = "agent";
let generation = 1;
let busy = false;
let observation = null;
let desktopObservation = null;
let activeShell = null;
const pendingStops = new Map();

async function clearObservation() {
  const previous = observation;
  observation = null;
  if (previous) await Promise.all([...previous.elements.values()].map(item =>
    item.handle.dispose().catch(() => undefined)));
}

function clearDesktopObservation() {
  desktopObservation = null;
}

async function captureDesktop() {
  const directory = await mkdtemp(join(tmpdir(), "opengrok-screen-"));
  const path = join(directory, "desktop.png");
  try {
    await exec("scrot", [path], { timeout: 15_000 });
    const image = await readFile(path);
    if (image.length < 24 || image.length > 2_000_000 ||
      !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Desktop screenshot is not a supported PNG");
    }
    return { image, width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function desktopKeysym(key) {
  if (typeof key !== "string" || key.length > 40) return null;
  const parts = key.split("+");
  const modifiers = parts.slice(0, -1);
  const base = parts.at(-1);
  const valid = modifiers.length <= 3 && new Set(modifiers).size === modifiers.length &&
    modifiers.every(item => ["Ctrl", "Alt", "Shift", "Super"].includes(item)) &&
    (/^[A-Za-z0-9]$/.test(base) || ["Return", "Tab", "Escape", "BackSpace", "Delete",
      "Up", "Down", "Left", "Right", "Home", "End", "Prior", "Next", "space"].includes(base) ||
      /^F(?:[1-9]|1[0-2])$/.test(base));
  return valid ? [...modifiers.map(item => item.toLowerCase()),
    /^[A-Za-z]$/.test(base) ? base.toLowerCase() : base].join("+") : null;
}

function setClipboard(value) {
  return new Promise((resolve, reject) => {
    const child = spawn("xclip", ["-selection", "clipboard", "-i"], { stdio: ["pipe", "ignore", "ignore"] });
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Clipboard update timed out")); }, 5000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("exit", code => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`xclip exited ${code}`));
    });
    child.stdin.end(value);
  });
}

async function observePage() {
  await clearObservation();
  const id = randomUUID();
  const elements = new Map();
  const locator = page.locator("a[href],button,input:not([type=hidden]):not([type=password]),textarea,[role=button]");
  const count = Math.min(await locator.count(), 150);
  for (let index = 0; index < count && elements.size < 60; index++) {
    const handle = await locator.nth(index).elementHandle();
    if (!handle) continue;
    try {
      if (!await handle.isVisible()) { await handle.dispose(); continue; }
      const info = await handle.evaluate(element => {
        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute("type") || "text").toLowerCase();
        const textInput = tag === "textarea" || tag === "input" &&
          ["text", "search", "email", "url", "tel", "number"].includes(type);
        const kind = tag === "a" ? "link" : textInput ? "textbox" : "button";
        const label = element.getAttribute("aria-label") ||
          element.labels?.[0]?.textContent || element.getAttribute("placeholder") ||
          element.textContent || element.getAttribute("name") || element.getAttribute("id") || tag;
        return { kind, label: label.trim().replace(/\s+/g, " ").slice(0, 120),
          href: tag === "a" ? element.href : undefined,
          value: textInput ? element.value.slice(0, 200) : undefined,
          checked: tag === "input" && ["checkbox", "radio"].includes(type) ? element.checked : undefined };
      });
      const ref = `e${elements.size + 1}`;
      elements.set(ref, { handle, ...info });
    } catch {
      await handle.dispose().catch(() => undefined);
    }
  }
  observation = { id, url: page.url(), page, elements };
  return { observationId: id, elements: [...elements.entries()].map(([ref, item]) => ({
    ref, kind: item.kind, label: item.label,
    ...(item.href ? { href: item.href } : {}),
    ...(item.value !== undefined ? { value: item.value } : {}),
    ...(item.checked !== undefined ? { checked: item.checked } : {}),
  })) };
}

async function runShell(command, timeoutMs, operationId) {
  const { OPENGROK_RUNTIME_TOKEN: _secret, ...environment } = process.env;
  if (configuredProxy === "gateway") {
    environment.HTTP_PROXY = browserProxy;
    environment.HTTPS_PROXY = browserProxy;
    environment.http_proxy = browserProxy;
    environment.https_proxy = browserProxy;
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: workspace, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stoppedByUser = false;
    let finished = false;
    let stopSignalSent = false;
    let killTimer;
    const stop = () => {
      if (!child.pid || finished || stopSignalSent) return false;
      stopSignalSent = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
      killTimer = setTimeout(() => {
        if (!finished) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      }, 500);
      killTimer.unref();
      return true;
    };
    const shell = { operationId, stop: () => { if (stop()) stoppedByUser = true; } };
    activeShell = shell;
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (stdout.length > 64_000) stop();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
      if (stderr.length > 64_000) stop();
    });
    child.on("error", error => {
      finished = true;
      if (activeShell === shell) activeShell = null;
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      finished = true;
      if (activeShell === shell) activeShell = null;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ exitCode: code, signal, timedOut, stoppedByUser,
        stdout: stdout.slice(0, 64_000), stderr: stderr.slice(0, 64_000) });
    });
  });
}

async function setVncInput(enabled) {
  const value = enabled ? "1" : "0";
  await exec("vncconfig", ["-display", ":1", "-set",
    `AcceptKeyEvents=${value}`, `AcceptPointerEvents=${value}`, `AcceptCutText=${value}`]);
  for (const name of ["AcceptKeyEvents", "AcceptPointerEvents", "AcceptCutText"]) {
    const { stdout } = await exec("vncconfig", ["-display", ":1", "-get", name]);
    if (stdout.trim() !== value) throw new Error(`VNC input state mismatch: ${name}`);
  }
}
await setVncInput(false);

function send(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}

async function body(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}

createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "Unauthorized" });
  try {
    if (request.method === "GET" && request.url === "/health") {
      await access(workspace);
      const { stdout: vncInput } = await exec("vncconfig", ["-display", ":1", "-get", "AcceptKeyEvents"]);
      await writeFile(`${workspace}/.health`, `${Date.now()}\n`);
      return send(response, 200, { ready: Boolean(context.browser()?.isConnected()) &&
        vncInput.trim() === (mode === "human" ? "1" : "0"),
        mode, busy, sessionId, generation, url: page.url() });
    }
    if (request.method === "POST" && request.url === "/control") {
      const input = await body(request);
      if (!["human", "agent"].includes(input.mode)) return send(response, 400, { error: "Invalid mode" });
      if (busy) return send(response, 409, { error: "Computer operation still running" });
      if (input.mode === "human") {
        await clearObservation();
        clearDesktopObservation();
        await setVncInput(true);
        mode = "human";
      } else {
        await clearObservation();
        clearDesktopObservation();
        await setVncInput(false);
        mode = "agent";
        page = context.pages().filter(candidate => !candidate.isClosed()).at(-1) || await context.newPage();
        generation += 1;
      }
      return send(response, 200, { mode, generation });
    }
    if (request.method === "POST" && request.url === "/stop") {
      const input = await body(request);
      if (typeof input.operationId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.operationId)) {
        return send(response, 400, { error: "Invalid operation ID" });
      }
      if (activeShell?.operationId === input.operationId) {
        activeShell.stop();
        return send(response, 200, { stopping: true, pending: false });
      }
      for (const [id, expiresAt] of pendingStops) if (expiresAt <= Date.now()) pendingStops.delete(id);
      if (pendingStops.size >= 100) return send(response, 503, { error: "Too many pending stops" });
      pendingStops.set(input.operationId, Date.now() + 120_000);
      return send(response, 200, { stopping: false, pending: true });
    }
    if (request.method === "POST" && request.url === "/operation") {
      const input = await body(request);
      if (mode !== "agent" || busy) return send(response, 409, { error: "Computer not available to agent" });
      if (!Number.isFinite(input.deadline) || input.deadline < Date.now()) return send(response, 409, { error: "Expired operation" });
      if (!["browser_open", "browser_read", "browser_screenshot", "browser_click", "browser_fill",
        "desktop_observe", "desktop_click", "desktop_key", "desktop_type", "shell_exec",
        "workspace_list", "workspace_read", "workspace_write"].includes(input.name)) {
        return send(response, 400, { error: "Unknown operation" });
      }
      busy = true;
      try {
        if (input.name === "workspace_list") {
          return send(response, 200, await listWorkspaceFiles(workspace, input.args?.path ?? "."));
        }
        if (input.name === "workspace_read") {
          return send(response, 200, await readWorkspaceFile(workspace, input.args?.path));
        }
        if (input.name === "workspace_write") {
          return send(response, 200, await writeWorkspaceFile(workspace, {
            ...input.args, operationId: input.operationId,
          }));
        }
        if (input.name === "browser_open") {
          if (typeof input.args?.url !== "string" || !await publicUrl(input.args.url)) {
            return send(response, 422, { error: "Only public HTTP(S) pages are allowed" });
          }
          await clearObservation();
          clearDesktopObservation();
          await page.goto(input.args.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          return send(response, 200, { url: page.url(), title: await page.title(),
            sessionId, generation });
        }
        if (input.name === "shell_exec") {
          if (typeof input.args?.command !== "string" || !input.args.command.trim() ||
            input.args.command.length > 2000 || !Number.isInteger(input.args.timeoutMs) ||
            input.args.timeoutMs < 1000 || input.args.timeoutMs > 30_000) {
            return send(response, 422, { error: "Invalid command" });
          }
          if (pendingStops.delete(input.operationId)) {
            return send(response, 409, { error: "Shell command stopped before starting" });
          }
          clearDesktopObservation();
          const result = await runShell(input.args.command, input.args.timeoutMs, input.operationId);
          return send(response, 200, { ...result, cwd: workspace, sessionId, generation });
        }
        if (input.name === "desktop_observe") {
          clearDesktopObservation();
          const { image, width, height } = await captureDesktop();
          const observationId = randomUUID();
          desktopObservation = { id: observationId, width, height, generation,
            controlEpoch: input.controlEpoch, createdAt: Date.now() };
          return send(response, 200, { observationId, width, height,
            imageBase64: image.toString("base64"), sessionId, generation });
        }
        if (["desktop_click", "desktop_key", "desktop_type"].includes(input.name)) {
          const observed = desktopObservation;
          if (!observed || observed.id !== input.args?.observationId ||
            observed.generation !== generation || observed.controlEpoch !== input.controlEpoch ||
            Date.now() - observed.createdAt > 120_000) {
            return send(response, 409, { error: "Desktop observation expired; capture the desktop again" });
          }
          if (input.name === "desktop_click" && (!Number.isInteger(input.args?.x) ||
            !Number.isInteger(input.args?.y) || input.args.x < 0 || input.args.y < 0 ||
            input.args.x >= observed.width || input.args.y >= observed.height ||
            !["left", "right", "double"].includes(input.args.button))) {
            return send(response, 422, { error: "Desktop click is outside the observed image" });
          }
          const keySpec = input.name === "desktop_key" ? desktopKeysym(input.args?.key) : null;
          if (input.name === "desktop_key" && !keySpec) {
            return send(response, 422, { error: "Unsupported desktop key" });
          }
          if (input.name === "desktop_type" && (typeof input.args?.text !== "string" ||
            !input.args.text.length || input.args.text.length > 2000 || input.args.text.includes("\0"))) {
            return send(response, 422, { error: "Invalid desktop text" });
          }
          clearDesktopObservation();
          await clearObservation();
          if (input.name === "desktop_click") {
            await exec("xdotool", ["mousemove", String(input.args.x), String(input.args.y),
              "click", input.args.button === "right" ? "3" : "1",
              ...(input.args.button === "double" ? ["click", "1"] : [])], { timeout: 5000 });
            return send(response, 200, { action: "click_sent", x: input.args.x, y: input.args.y,
              button: input.args.button, sessionId, generation });
          }
          if (input.name === "desktop_key") {
            await exec("xdotool", ["key", "--clearmodifiers", keySpec], { timeout: 5000 });
            return send(response, 200, { action: "key_sent", key: input.args.key, sessionId, generation });
          }
          try {
            await setClipboard(input.args.text);
            await exec("xdotool", ["key", "--clearmodifiers", "ctrl+v"], { timeout: 5000 });
            await new Promise(resolve => setTimeout(resolve, 150));
          } finally {
            await setClipboard("").catch(() => undefined);
          }
          return send(response, 200, { action: "paste_sent", length: input.args.text.length,
            sessionId, generation });
        }
        if (!await publicUrl(page.url())) return send(response, 403, { error: "Current page is not public" });
        if (input.name === "browser_screenshot") {
          const image = await page.screenshot({ type: "png", animations: "disabled", timeout: 15_000 });
          if (image.length > 2_000_000) return send(response, 413, { error: "Screenshot exceeds size limit" });
          return send(response, 200, { url: page.url(), title: await page.title(),
            imageBase64: image.toString("base64"), sessionId, generation });
        }
        if (input.name === "browser_click" || input.name === "browser_fill") {
          const observed = observation;
          const element = observed?.elements.get(input.args?.ref);
          if (!observed || observed.id !== input.args?.observationId ||
            observed.page !== page || observed.url !== page.url() || !element ||
            input.name === "browser_click" && element.kind === "textbox" ||
            input.name === "browser_fill" && element.kind !== "textbox") {
            return send(response, 409, { error: "Page observation expired; read the page again" });
          }
          if (input.name === "browser_fill") {
            const editable = await element.handle.evaluate(node => {
              const tag = node.tagName.toLowerCase();
              const type = (node.getAttribute("type") || "text").toLowerCase();
              return tag === "textarea" || tag === "input" &&
                ["text", "search", "email", "url", "tel", "number"].includes(type);
            });
            if (!editable || typeof input.args.value !== "string" || input.args.value.length > 2000) {
              return send(response, 422, { error: "Only non-password text fields can be filled" });
            }
          }
          const label = element.label;
          clearDesktopObservation();
          try {
            if (input.name === "browser_click") {
              await element.handle.click({ timeout: 15_000 });
              page = context.pages().filter(candidate => !candidate.isClosed()).at(-1) || page;
            } else {
              await element.handle.fill(input.args.value, { timeout: 15_000 });
            }
          } finally { await clearObservation(); }
          return send(response, 200, { url: page.url(), title: await page.title(),
            action: input.name === "browser_click" ? "clicked" : "filled",
            label, sessionId, generation });
        }
        const observedUrl = page.url();
        try {
          const text = await page.locator("body").innerText({ timeout: 15_000 });
          const observed = await observePage();
          if (page.url() !== observedUrl) {
            await clearObservation();
            return send(response, 409, { error: "Page changed while reading; read it again" });
          }
          return send(response, 200, { url: observedUrl, title: await page.title(),
            text: text.slice(0, 30_000), ...observed, sessionId, generation });
        } catch {
          await clearObservation();
          return send(response, 409, { error: "Page changed while reading; read it again" });
        }
      } finally {
        busy = false;
      }
    }
    if (request.method === "POST" && request.url === "/workspace/probe") {
      const marker = `${workspace}/.health`;
      await writeFile(marker, `${Date.now()}\n`);
      await access(marker);
      return send(response, 200, { ok: true });
    }
    return send(response, 404, { error: "Not found" });
  } catch (error) {
    const status = error instanceof WorkspaceFileError ? error.statusCode :
      error?.code === "ENOENT" ? 404 : 500;
    return send(response, status, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(3843, "0.0.0.0", () => console.log(`desktop runtime ${sessionId} ready`));
