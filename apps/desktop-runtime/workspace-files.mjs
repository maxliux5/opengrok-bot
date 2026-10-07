import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export class WorkspaceFileError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.statusCode = statusCode;
  }
}

const maxPathBytes = 240;
const maxPartBytes = 120;
const maxReadBytes = 64_000;
const maxWriteBytes = 32_000;

function partsFor(path, allowRoot = false) {
  if (path === "." && allowRoot) return [];
  if (typeof path !== "string" || !path || Buffer.byteLength(path) > maxPathBytes ||
    path.startsWith("/") || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)) {
    throw new WorkspaceFileError("Invalid workspace-relative path");
  }
  const parts = path.split("/");
  if (parts.length > 12 || parts.some(part => !part || part === "." || part === ".." ||
    Buffer.byteLength(part) > maxPartBytes)) {
    throw new WorkspaceFileError("Invalid workspace-relative path");
  }
  return parts;
}

function within(root, path) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function directory(root, parts, create = false) {
  let current = resolve(root);
  const base = await lstat(current);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new WorkspaceFileError("Workspace root is unavailable");
  for (const part of parts) {
    current = join(current, part);
    if (create) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceFileError("Workspace path contains a link or non-directory");
    }
  }
  return current;
}

async function checkedFile(root, path) {
  const parts = partsFor(path);
  const parent = await directory(root, parts.slice(0, -1));
  const target = join(parent, parts.at(-1));
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new WorkspaceFileError("Only regular workspace files can be read");
  }
  if (info.size > maxReadBytes) throw new WorkspaceFileError("Workspace file exceeds read limit", 413);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await realpath(`/proc/self/fd/${file.fd}`);
    if (!within(resolve(root), actual)) throw new WorkspaceFileError("Workspace path escaped its root");
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > maxReadBytes) {
      throw new WorkspaceFileError("Workspace file exceeds read limit", 413);
    }
    const content = await file.readFile();
    if (content.length > maxReadBytes) throw new WorkspaceFileError("Workspace file exceeds read limit", 413);
    return { content, sha256: createHash("sha256").update(content).digest("hex") };
  } finally { await file.close(); }
}

export async function listWorkspaceFiles(root, path = ".") {
  const parts = partsFor(path, true);
  const target = await directory(root, parts);
  const entries = await readdir(target, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path, entries: entries.slice(0, 100).map(entry => ({
    name: entry.name,
    kind: entry.isSymbolicLink() ? "blocked_link" : entry.isDirectory() ? "directory" :
      entry.isFile() ? "file" : "other",
  })), truncated: entries.length > 100 };
}

export async function readWorkspaceFile(root, path) {
  const { content, sha256 } = await checkedFile(root, path);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { throw new WorkspaceFileError("Only UTF-8 text files can be read"); }
  return { path, content: text, sha256, sizeBytes: content.length };
}

async function checkExpected(root, path, expectedSha256) {
  let current;
  try { current = await checkedFile(root, path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!current && expectedSha256) throw new WorkspaceFileError("File no longer exists", 409);
  if (current && !expectedSha256) throw new WorkspaceFileError("File already exists; read it before overwriting", 409);
  if (current && current.sha256 !== expectedSha256) throw new WorkspaceFileError("File changed since it was read", 409);
  return Boolean(current);
}

export async function writeWorkspaceFile(root, input) {
  const parts = partsFor(input.path);
  if (typeof input.content !== "string" ||
    input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
    !/^[a-f0-9-]{36}$/.test(input.operationId)) {
    throw new WorkspaceFileError("Invalid workspace write request");
  }
  const content = Buffer.from(input.content, "utf8");
  if (content.length > maxWriteBytes) throw new WorkspaceFileError("Workspace write exceeds size limit", 413);
  const parent = await directory(root, parts.slice(0, -1), true);
  const target = join(parent, parts.at(-1));
  const existed = await checkExpected(root, input.path, input.expectedSha256);
  const temporary = join(parent, `.${parts.at(-1)}.${input.operationId}.part`);
  let written = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    try {
      const actual = await realpath(`/proc/self/fd/${file.fd}`);
      if (!within(resolve(root), actual)) throw new WorkspaceFileError("Workspace path escaped its root");
      await file.writeFile(content);
      await file.sync();
    } finally { await file.close(); }
    await checkExpected(root, input.path, input.expectedSha256);
    await rename(temporary, target);
    written = true;
    const parentFile = await open(parent, constants.O_RDONLY);
    try { await parentFile.sync(); }
    finally { await parentFile.close(); }
  } finally {
    if (!written) await unlink(temporary).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const verified = await checkedFile(root, input.path);
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (verified.sha256 !== sha256) throw new WorkspaceFileError("Workspace write verification failed", 500);
  return { path: input.path, sha256, sizeBytes: content.length, created: !existed };
}
