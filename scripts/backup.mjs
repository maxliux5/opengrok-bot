import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
process.umask(0o077);
const sourceDataDir = resolve(root, process.env.OPENGROK_DATA_DIR || ".local");
const dbContainer = process.env.OPENGROK_DB_CONTAINER || "opengrok-postgres";
const dbUser = process.env.OPENGROK_DB_USER || "opengrok";
const dbName = process.env.OPENGROK_DB_NAME || "opengrok_bot";
const desktopContainer = process.env.OPENGROK_DESKTOP_CONTAINER || "opengrok-desktop";
const homeVolume = process.env.OPENGROK_DESKTOP_HOME_VOLUME || "desktop_desktop_home";
const workspaceVolume = process.env.OPENGROK_DESKTOP_WORKSPACE_VOLUME || "desktop_desktop_workspace";
const secretNames = ["dev.env", "master.key", "host.token", "desktop.env"];
const optionalSecretNames = ["github.env"];
const dataNames = ["db.dump", "artifacts.tar", "desktop-home.tar", "desktop-workspace.tar", "host-journal.sqlite"];

function assertIdentifier(value, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${label} 只能包含字母、数字和下划线`);
}

function child(command, args, options = {}) {
  return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
}

async function waitProcess(process) {
  let stderr = "";
  process.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", code => code === 0 ? resolve() : reject(new Error(stderr || `退出码 ${code}`)));
  });
}

async function capture(command, args, options) {
  const process = child(command, args, options);
  let stdout = "";
  process.stdout.on("data", chunk => { stdout += chunk; });
  await waitProcess(process);
  return stdout.trim();
}

async function streamFile(command, args, path, options) {
  const process = child(command, args, options);
  const result = waitProcess(process);
  await Promise.all([pipeline(process.stdout, createWriteStream(path, { flags: "wx", mode: 0o600 })), result]);
}

async function feedFile(path, command, args) {
  const process = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  process.stdout.resume();
  const result = waitProcess(process);
  await Promise.all([pipeline(createReadStream(path), process.stdin), result]);
}

let dockerCommand;
let dockerPrefix;
async function docker(args) {
  if (!dockerCommand) {
    try {
      await capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
      dockerCommand = "docker";
      dockerPrefix = [];
    } catch {
      dockerCommand = "sudo";
      dockerPrefix = ["-n", "env", `DOCKER_CONFIG=${join(process.env.HOME || "", ".docker")}`, "docker"];
      await capture(dockerCommand, [...dockerPrefix, "info", "--format", "{{.ServerVersion}}"]);
    }
  }
  return [dockerCommand, [...dockerPrefix, ...args]];
}

async function dockerCapture(args) {
  const [command, fullArgs] = await docker(args);
  return capture(command, fullArgs);
}

function below(path, parent) {
  const suffix = relative(parent, path);
  return !suffix || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

async function portOpen(port) {
  return new Promise(resolvePort => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = open => { socket.destroy(); resolvePort(open); };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function assertQuiesced() {
  for (const name of ["opengrok-api.service", "opengrok-worker.service", "opengrok-worker-2.service",
    "opengrok-host.service", "opengrok-web.service"]) {
    try {
      const state = await capture("systemctl", ["--user", "show", name, "-p", "ActiveState", "--value"]);
      if (state !== "inactive") {
        throw new Error(`先停止 systemd 用户服务 ${name}（当前 ${state}）`);
      }
    } catch (error) {
      if (error.message?.startsWith("先停止 systemd 用户服务")) throw error;
    }
  }
  for (const port of [3840, 3841, 3842, 3843, 3844, 3845, 3846, 3847, 3848,
    5173, 8443, 6080, 6081]) {
    if (await portOpen(port)) throw new Error(`端口 ${port} 仍在监听；先停止 API、Host 和桌面`);
  }
  const processes = await capture("ps", ["-eo", "args="]);
  if (processes.split("\n").some(line => /(?:pnpm dev:worker|@opengrok\/worker|apps\/worker\/src\/index\.ts)/.test(line))) {
    throw new Error("Worker 仍在运行；先停止所有 Worker");
  }
  const [command, prefix] = await docker(["inspect", "--format", "{{.State.Running}}", desktopContainer]);
  if (await capture(command, prefix) !== "false") throw new Error("桌面容器仍在运行；先停止桌面以冻结浏览器 profile 和文件");
}

async function volumeMountpoint(name) {
  const [command, args] = await docker(["volume", "inspect", "--format", "{{.Mountpoint}}", name]);
  const mountpoint = await capture(command, args);
  if (!isAbsolute(mountpoint)) throw new Error(`卷 ${name} 没有绝对挂载路径`);
  return mountpoint;
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: (await stat(path)).size };
}

async function quickCheck(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = db.prepare("PRAGMA quick_check").get();
    if (Object.values(result || {})[0] !== "ok") throw new Error(`host journal 校验失败：${JSON.stringify(result)}`);
  } finally { db.close(); }
}

async function snapshotJournal(path) {
  const source = join(sourceDataDir, "host-journal.sqlite");
  const db = new DatabaseSync(source);
  try {
    const escaped = path.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally { db.close(); }
  await quickCheck(path);
}

async function create(dataOutput, secretOutput) {
  assertIdentifier(dbUser, "数据库用户");
  assertIdentifier(dbName, "数据库名");
  const dataDir = resolve(dataOutput);
  const secretsDir = resolve(secretOutput);
  if (below(dataDir, secretsDir) || below(secretsDir, dataDir)) throw new Error("数据包与密钥包必须位于互不包含的目录");
  if (below(dataDir, join(sourceDataDir, "artifacts")) || below(secretsDir, join(sourceDataDir, "artifacts"))) {
    throw new Error("备份输出不能放在成果目录中");
  }
  await assertQuiesced();
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(secretsDir, { mode: 0o700 });
  const id = randomUUID();
  const [dockerBin, dumpArgs] = await docker(["exec", dbContainer, "pg_dump", "-U", dbUser, "-d", dbName, "-Fc", "-Z0"]);
  await streamFile(dockerBin, dumpArgs, join(dataDir, "db.dump"));
  await streamFile("tar", ["-C", join(sourceDataDir, "artifacts"), "-cf", "-", "."], join(dataDir, "artifacts.tar"));
  for (const [volume, name] of [[homeVolume, "desktop-home.tar"], [workspaceVolume, "desktop-workspace.tar"]]) {
    const mountpoint = await volumeMountpoint(volume);
    await streamFile("sudo", ["-n", "tar", "--numeric-owner", "-C", mountpoint, "-cf", "-", "."], join(dataDir, name));
  }
  await snapshotJournal(join(dataDir, "host-journal.sqlite"));
  const includedSecrets = [...secretNames];
  for (const name of optionalSecretNames) {
    try { await stat(join(sourceDataDir, name)); includedSecrets.push(name); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  for (const name of includedSecrets) {
    let source = join(sourceDataDir, name);
    if (name === "dev.env") {
      try { await stat(source); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        source = join(sourceDataDir, "restore.env");
      }
    }
    await copyFile(source, join(secretsDir, name));
    await chmod(join(secretsDir, name), 0o600);
  }
  const dataFiles = Object.fromEntries(await Promise.all(dataNames.map(async name => [name, await digest(join(dataDir, name))])));
  const secretFiles = Object.fromEntries(await Promise.all(includedSecrets.map(async name => [name, await digest(join(secretsDir, name))])));
  const common = { format: 1, id, createdAt: new Date().toISOString() };
  await writeFile(join(dataDir, "manifest.json"), `${JSON.stringify({ ...common,
    database: { container: dbContainer, name: dbName },
    desktopVolumes: { home: homeVolume, workspace: workspaceVolume }, files: dataFiles }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(join(secretsDir, "manifest.json"), `${JSON.stringify({ ...common, files: secretFiles }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ id, dataDir, secretsDir, files: dataNames.length + includedSecrets.length }));
}

async function verifyTar(path) {
  const entries = (await capture("tar", ["-tf", path])).split("\n").filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.split("/").includes("..")) throw new Error(`归档包含非法路径：${entry}`);
  }
  if (!entries.length) throw new Error(`空归档：${path}`);
}

async function verify(dataInput, secretInput) {
  const dataDir = resolve(dataInput);
  const secretsDir = resolve(secretInput);
  const data = JSON.parse(await readFile(join(dataDir, "manifest.json"), "utf8"));
  const secrets = JSON.parse(await readFile(join(secretsDir, "manifest.json"), "utf8"));
  if (data.format !== 1 || secrets.format !== 1 || data.id !== secrets.id) throw new Error("备份格式或数据/密钥快照 ID 不匹配");
  const includedSecrets = Object.keys(secrets.files);
  if (secretNames.some(name => !includedSecrets.includes(name)) ||
    includedSecrets.some(name => ![...secretNames, ...optionalSecretNames].includes(name))) {
    throw new Error("密钥包文件集合无效");
  }
  for (const [dir, manifest, names] of [[dataDir, data, dataNames], [secretsDir, secrets, includedSecrets]]) {
    if (Object.keys(manifest.files).sort().join() !== [...names].sort().join()) throw new Error("备份文件集合与清单不一致");
    for (const name of names) {
      const expected = manifest.files[name];
      const actual = await digest(join(dir, name));
      if (expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) throw new Error(`文件摘要或字节数不符：${name}`);
    }
  }
  await quickCheck(join(dataDir, "host-journal.sqlite"));
  for (const name of ["artifacts.tar", "desktop-home.tar", "desktop-workspace.tar"]) await verifyTar(join(dataDir, name));
  const [command, args] = await docker(["run", "--rm", "--network", "none", "-v", `${dataDir}:/backup:ro`,
    "--entrypoint", "pg_restore", "postgres:16.9-bookworm", "-l", "/backup/db.dump"]);
  await capture(command, args);
  console.log(JSON.stringify({ id: data.id, verified: true, files: dataNames.length + includedSecrets.length }));
}

async function assertMissing(path) {
  try {
    await stat(path);
    throw new Error(`目标已存在，拒绝覆盖：${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function restore(dataInput, secretInput, targetInput, targetDatabase) {
  assertIdentifier(dbUser, "数据库用户");
  assertIdentifier(targetDatabase, "目标数据库名");
  await verify(dataInput, secretInput);
  const dataDir = resolve(dataInput);
  const secretsDir = resolve(secretInput);
  const targetDir = resolve(targetInput);
  const artifactRoot = join(targetDir, "artifacts");
  if (below(targetDir, join(sourceDataDir, "artifacts")) || below(targetDir, dataDir) ||
    below(targetDir, secretsDir) || targetDir === sourceDataDir) {
    throw new Error("恢复目标不能覆盖源数据、备份或密钥目录");
  }
  await assertMissing(targetDir);
  const dbExists = await dockerCapture(["exec", dbContainer, "psql", "-U", dbUser,
    "-d", "postgres", "-Atc", `SELECT 1 FROM pg_database WHERE datname='${targetDatabase}'`]);
  if (dbExists === "1") throw new Error(`目标数据库已存在：${targetDatabase}`);
  const snapshot = JSON.parse(await readFile(join(dataDir, "manifest.json"), "utf8"));
  const secretSnapshot = JSON.parse(await readFile(join(secretsDir, "manifest.json"), "utf8"));
  const prefix = `opengrok_restore_${snapshot.id.slice(0, 8).replaceAll("-", "")}`;
  const home = `${prefix}_home`;
  const workspace = `${prefix}_workspace`;
  const existingVolumes = new Set((await dockerCapture(["volume", "ls", "--format", "{{.Name}}"]))
    .split("\n").filter(Boolean));
  if (existingVolumes.has(home) || existingVolumes.has(workspace)) {
    throw new Error(`目标 Docker 卷已存在：${home} 或 ${workspace}`);
  }

  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await capture("tar", ["-C", artifactRoot, "--no-same-owner", "-xf", join(dataDir, "artifacts.tar")]);
  for (const name of ["master.key", "host.token", "desktop.env",
    ...(secretSnapshot.files["github.env"] ? ["github.env"] : []), "host-journal.sqlite"]) {
    const source = name === "host-journal.sqlite" ? dataDir : secretsDir;
    await copyFile(join(source, name), join(targetDir, name));
    await chmod(join(targetDir, name), 0o600);
  }
  const envFile = await readFile(join(secretsDir, "dev.env"), "utf8");
  const databaseLine = envFile.split("\n").find(line => line.startsWith("DATABASE_URL="));
  if (!databaseLine) throw new Error("密钥包缺少 DATABASE_URL");
  const databaseUrl = new URL(databaseLine.slice("DATABASE_URL=".length));
  databaseUrl.pathname = `/${targetDatabase}`;
  await writeFile(join(targetDir, "restore.env"),
    `DATABASE_URL=${databaseUrl.href}\nOPENGROK_DATA_DIR=${targetDir}\n`, { flag: "wx", mode: 0o600 });

  await dockerCapture(["exec", dbContainer, "createdb", "-U", dbUser, targetDatabase]);
  const [dockerBin, restoreArgs] = await docker(["exec", "-i", dbContainer, "pg_restore", "-U", dbUser,
    "-d", targetDatabase, "--no-owner", "--no-privileges", "--exit-on-error"]);
  await feedFile(join(dataDir, "db.dump"), dockerBin, restoreArgs);
  for (const [volume, archive] of [[home, "desktop-home.tar"], [workspace, "desktop-workspace.tar"]]) {
    await dockerCapture(["volume", "create", volume]);
    const mountpoint = await volumeMountpoint(volume);
    await capture("sudo", ["-n", "tar", "--numeric-owner", "-C", mountpoint,
      "-xf", join(dataDir, archive)]);
  }

  const rows = await dockerCapture(["exec", dbContainer, "psql", "-U", dbUser,
    "-d", targetDatabase, "-At", "-F", "\t", "-c",
    "SELECT storage_path,sha256,size_bytes FROM artifacts ORDER BY id"]);
  let artifactCount = 0;
  for (const row of rows.split("\n").filter(Boolean)) {
    const [storedPath, expectedHash, expectedSize] = row.split("\t");
    if (!storedPath || isAbsolute(storedPath)) throw new Error(`成果路径未迁移：${storedPath}`);
    const path = resolve(artifactRoot, storedPath);
    if (!below(path, artifactRoot) || path === artifactRoot) throw new Error(`成果路径越界：${storedPath}`);
    const actual = await digest(path);
    if (actual.sha256 !== expectedHash || actual.bytes !== Number(expectedSize)) {
      throw new Error(`恢复的成果摘要不符：${storedPath}`);
    }
    artifactCount++;
  }
  await quickCheck(join(targetDir, "host-journal.sqlite"));
  const result = { snapshotId: snapshot.id, targetDir, database: targetDatabase,
    desktopVolumes: { home, workspace }, verifiedArtifacts: artifactCount,
    status: "restored_for_isolated_validation" };
  await writeFile(join(targetDir, "restore-manifest.json"), `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(result));
}

const [action, dataPath, secretPath, targetPath, targetDatabase] = process.argv.slice(2);
if (!["create", "verify", "restore"].includes(action) || !dataPath || !secretPath ||
  (action === "restore" && (!targetPath || !targetDatabase))) {
  throw new Error("用法：node scripts/backup.mjs create|verify <数据目录> <独立密钥目录>；restore 另加 <全新目标目录> <全新数据库名>");
}
if (action === "create") await create(dataPath, secretPath);
else if (action === "verify") await verify(dataPath, secretPath);
else await restore(dataPath, secretPath, targetPath, targetDatabase);
