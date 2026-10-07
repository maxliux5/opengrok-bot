import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { dataDir } from "./config.js";

const derive = promisify(scrypt);

function masterKey(): Buffer {
  const configured = process.env.OPENGROK_MASTER_KEY;
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("OPENGROK_MASTER_KEY must contain 32 base64 bytes");
    return key;
  }
  const path = join(dataDir, "master.key");
  try {
    writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("Invalid local master key");
  return key;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decryptSecret(value: string): string {
  const buffer = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8");
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = (await derive(password, salt, 64)) as Buffer;
  return { salt, hash: hash.toString("hex") };
}

export async function verifyPassword(password: string, salt: string, expected: string) {
  const actual = (await derive(password, salt, 64)) as Buffer;
  const stored = Buffer.from(expected, "hex");
  return stored.length === actual.length && timingSafeEqual(stored, actual);
}
