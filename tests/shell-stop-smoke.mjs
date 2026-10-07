import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const token = (await readFile(".local/desktop.env", "utf8")).trim().split("=", 2)[1];
const operationId = randomUUID();
const marker = `.stop-before-start-${operationId}`;

async function runtime(path, body) {
  return fetch(`http://127.0.0.1:3843${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stopped = await runtime("/stop", { operationId });
assert.equal(stopped.status, 200);
assert.deepEqual(await stopped.json(), { stopping: false, pending: true });

const rejected = await runtime("/operation", {
  operationId, name: "shell_exec",
  args: { command: `printf unsafe > /workspace/${marker}`, timeoutMs: 5000 },
  deadline: Date.now() + 10_000,
});
assert.equal(rejected.status, 409);
assert.match((await rejected.json()).error, /stopped before starting/);

const check = await runtime("/operation", {
  name: "shell_exec", args: { command: `test ! -e /workspace/${marker}`, timeoutMs: 5000 },
  deadline: Date.now() + 10_000,
});
assert.equal(check.status, 200);
assert.equal((await check.json()).exitCode, 0);
console.log(JSON.stringify({ operationId, stoppedBeforeStart: true, physicalEffect: false }));
