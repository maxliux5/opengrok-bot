import { readFileSync } from "node:fs";

const runtimeToken = readFileSync(".local/desktop.env", "utf8").trim().split("=", 2)[1];
const hostToken = readFileSync(".local/host.token", "utf8").trim();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function hostState() {
  const response = await fetch("http://127.0.0.1:3842/state", {
    headers: { authorization: `Bearer ${hostToken}` },
  });
  if (!response.ok) throw new Error(`Host state: ${response.status}`);
  return (await response.json()).computer;
}

const initial = await hostState();
if (initial.status !== "ready" || initial.controlMode !== "agent" || initial.operationBusy) {
  throw new Error("Computer must be idle in Agent mode before this test");
}

const operation = fetch("http://127.0.0.1:3843/operation", {
  method: "POST",
  headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "shell_exec", args: { command: "sleep 6", timeoutMs: 10_000 },
    deadline: Date.now() + 15_000 }),
});

await wait(700);
const takeover = await fetch("http://127.0.0.1:3842/control", {
  method: "POST", headers: { authorization: `Bearer ${hostToken}` },
});
const takeoverResult = await takeover.json();
const pending = await hostState();
const operationResult = await operation;
let granted = await hostState();
for (let attempt = 0; attempt < 12 && granted.controlMode !== "human"; attempt++) {
  await wait(1000);
  granted = await hostState();
}
if (granted.controlMode === "human" && granted.controlId) {
  const returned = await fetch(`http://127.0.0.1:3842/control/${granted.controlId}`, {
    method: "DELETE", headers: { authorization: `Bearer ${hostToken}` },
  });
  if (!returned.ok) throw new Error(`Return control: ${returned.status}`);
}
let recovered = await hostState();
for (let attempt = 0; attempt < 12 && recovered.controlMode !== "agent"; attempt++) {
  await wait(1000);
  recovered = await hostState();
}
console.log(JSON.stringify({ takeoverStatus: takeover.status, pending: takeoverResult.pending,
  pendingMode: pending.controlMode, operationStatus: operationResult.status,
  grantedMode: granted.controlMode, recoveredMode: recovered.controlMode,
  recoveredStatus: recovered.status }));
if (takeover.status !== 200 || takeoverResult.pending !== true || pending.controlMode !== "handing_off" ||
  operationResult.status !== 200 || granted.controlMode !== "human" || granted.status !== "ready" ||
  recovered.controlMode !== "agent" || recovered.status !== "ready") process.exitCode = 1;
