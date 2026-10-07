import { createHash, randomBytes, randomUUID } from "node:crypto";
import { query, transaction } from "./db.js";
import { DomainError } from "./errors.js";
import { hashPassword, verifyPassword } from "./crypto.js";

type UserRow = { id: string; username: string; password_salt: string; password_hash: string };

export async function hasOwner(): Promise<boolean> {
  const result = await query("SELECT 1 FROM users LIMIT 1");
  return Boolean(result.rowCount);
}

export async function setupOwner(username: string, password: string) {
  if (username.trim().length < 2 || password.length < 12) {
    throw new DomainError("用户名至少 2 字，密码至少 12 字", 400, "weak_credentials");
  }
  const { salt, hash } = await hashPassword(password);
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(612031588)");
    const existing = await client.query("SELECT 1 FROM users LIMIT 1");
    if (existing.rowCount) throw new DomainError("账号已初始化", 409, "already_initialized");
    const id = randomUUID();
    await client.query(
      "INSERT INTO users(id, username, password_salt, password_hash) VALUES ($1,$2,$3,$4)",
      [id, username.trim(), salt, hash],
    );
    const botId = randomUUID();
    await client.query(
      "INSERT INTO bots(id, owner_id, name, description, instructions) VALUES ($1,$2,$3,$4,$5)",
      [botId, id, "研究助手", "网页研究与报告", "用中文回答。研究时引用实际访问的网页。完成任务后提供可打开的报告。"],
    );
    await client.query("INSERT INTO bot_execution_slots(bot_id) VALUES ($1)", [botId]);
    return { id, username: username.trim() };
  });
}

export async function login(username: string, password: string) {
  return transaction(async client => {
    const result = await client.query<UserRow>(
      "SELECT id,username,password_salt,password_hash FROM users WHERE username=$1 FOR SHARE", [username],
    );
    const row = result.rows[0];
    if (!row || !(await verifyPassword(password, row.password_salt, row.password_hash))) {
      throw new DomainError("用户名或密码错误", 401, "invalid_credentials");
    }
    const token = randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES ($1,$2,now()+interval '30 days')",
      [createHash("sha256").update(token).digest("hex"), row.id],
    );
    return token;
  });
}

export async function changePassword(ownerId: string, currentPassword: string, newPassword: string) {
  if (newPassword.length < 12 || newPassword.length > 500) {
    throw new DomainError("新密码长度应为 12 到 500 字", 400, "weak_credentials");
  }
  return transaction(async client => {
    const result = await client.query<UserRow>(
      "SELECT id,username,password_salt,password_hash FROM users WHERE id=$1 FOR UPDATE", [ownerId],
    );
    const row = result.rows[0];
    if (!row || !(await verifyPassword(currentPassword, row.password_salt, row.password_hash))) {
      throw new DomainError("当前密码错误", 401, "invalid_credentials");
    }
    if (newPassword === currentPassword) {
      throw new DomainError("新密码不能与当前密码相同", 400, "same_password");
    }
    const { salt, hash } = await hashPassword(newPassword);
    await client.query("UPDATE users SET password_salt=$2,password_hash=$3 WHERE id=$1", [ownerId, salt, hash]);
    await client.query("DELETE FROM sessions WHERE owner_id=$1", [ownerId]);
    const token = randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES ($1,$2,now()+interval '30 days')",
      [createHash("sha256").update(token).digest("hex"), ownerId],
    );
    return token;
  });
}

export async function createSession(ownerId: string) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await query(
    "INSERT INTO sessions(token_hash,owner_id,expires_at) VALUES ($1,$2,now()+interval '30 days')",
    [tokenHash, ownerId],
  );
  return token;
}

export async function ownerForSession(token: string | undefined) {
  if (!token) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const result = await query<{ id: string; username: string }>(
    `SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.owner_id
     WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash],
  );
  return result.rows[0] || null;
}

export async function logout(token: string | undefined) {
  if (!token) return;
  const hash = createHash("sha256").update(token).digest("hex");
  await query("DELETE FROM sessions WHERE token_hash=$1", [hash]);
}
