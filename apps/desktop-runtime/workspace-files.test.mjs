import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile } from "./workspace-files.mjs";

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "opengrok-workspace-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("workspace create, list, read and compare-and-swap overwrite", async () => withWorkspace(async root => {
  const path = "notes/研究.txt";
  const first = await writeWorkspaceFile(root, { path, content: "第一版\n", operationId: randomUUID() });
  assert.equal(first.created, true);
  assert.equal(first.sha256, createHash("sha256").update("第一版\n").digest("hex"));
  assert.deepEqual((await listWorkspaceFiles(root, "notes")).entries,
    [{ name: "研究.txt", kind: "file" }]);
  assert.equal((await readWorkspaceFile(root, path)).content, "第一版\n");
  await assert.rejects(writeWorkspaceFile(root, { path, content: "误覆盖", operationId: randomUUID() }),
    error => error.statusCode === 409);
  await assert.rejects(writeWorkspaceFile(root, { path, content: "旧摘要", expectedSha256: "0".repeat(64),
    operationId: randomUUID() }), error => error.statusCode === 409);
  const second = await writeWorkspaceFile(root, { path, content: "第二版\n",
    expectedSha256: first.sha256, operationId: randomUUID() });
  assert.equal(second.created, false);
  assert.equal((await readWorkspaceFile(root, path)).content, "第二版\n");
  assert.equal((await readFile(join(root, path), "utf8")), "第二版\n");
}));

test("workspace rejects traversal, links, binary and oversized content", async () => withWorkspace(async root => {
  const outside = await mkdtemp(join(tmpdir(), "opengrok-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "escape"));
    for (const path of ["../secret", "/tmp/secret", "a/../secret", "a\\secret", "escape/secret.txt"]) {
      await assert.rejects(readWorkspaceFile(root, path));
      await assert.rejects(writeWorkspaceFile(root, { path, content: "changed", operationId: randomUUID() }));
    }
    await assert.rejects(listWorkspaceFiles(root, "escape"));
    assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
    await writeFile(join(root, "binary"), Buffer.from([0xff]));
    await assert.rejects(readWorkspaceFile(root, "binary"));
    await assert.rejects(writeWorkspaceFile(root, { path: "large.txt", content: "x".repeat(32_001),
      operationId: randomUUID() }), error => error.statusCode === 413);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));
