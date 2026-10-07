import { execFile } from "node:child_process";
import { chmod, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const directory = join(root, ".local", "tls");
const key = join(directory, "key.pem");
const cert = join(directory, "cert.pem");
process.umask(0o077);
await mkdir(directory, { recursive: true, mode: 0o700 });
const exists = await Promise.all([key, cert].map(async path => {
  try { await stat(path); return true; }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}));
if (exists.every(Boolean)) {
  console.log(`本机 TLS 证书已存在：${cert}`);
} else if (exists.some(Boolean)) {
  throw new Error("本机 TLS 证书或私钥不完整；请人工检查，脚本不会覆盖已有文件");
} else {
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-days", "365",
    "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { timeout: 30_000 });
  await chmod(key, 0o600);
  await chmod(cert, 0o600);
  console.log(`已生成仅用于本机的 TLS 证书：${cert}`);
}
