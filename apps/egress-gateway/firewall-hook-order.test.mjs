import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyHookOrder } from "../../scripts/firewall-hook-order.mjs";

const own = "-A DOCKER-USER -s 172.19.0.0/16 -i br-desktop -j OG_DESKTOP_FWD";
const other = "-A DOCKER-USER -s 172.20.0.0/16 -i br-restore -j OG_RESTORE_FWD";
const verify = rules => verifyHookOrder(rules, "DOCKER-USER", "172.19.0.0/16",
  "br-desktop", "OG_DESKTOP_FWD", "FWD");

test("a managed hook for another exact bridge may precede this desktop", () => {
  assert.doesNotThrow(() => verify([other, own, "-A DOCKER-USER -j RETURN"]));
  assert.doesNotThrow(() => verify([own, other]));
});

test("a broad or same-bridge rule ahead of the hook is rejected", () => {
  for (const prior of [
    "-A DOCKER-USER -j ACCEPT",
    "-A DOCKER-USER -s 172.20.0.0/16 -i br+ -j OG_RESTORE_FWD",
    "-A DOCKER-USER -s 172.20.0.0/16 -i br-desktop -j OG_RESTORE_FWD",
  ]) {
    assert.throws(() => verify([prior, own]));
  }
  assert.throws(() => verify([other]));
});

test("INPUT uses the same ordering rule", () => {
  assert.doesNotThrow(() => verifyHookOrder([
    "-A INPUT -s 172.20.0.0/16 -i br-restore -j OG_RESTORE_INPUT",
    "-A INPUT -s 172.19.0.0/16 -i br-desktop -j OG_DESKTOP_INPUT",
  ], "INPUT", "172.19.0.0/16", "br-desktop", "OG_DESKTOP_INPUT", "INPUT"));
});
