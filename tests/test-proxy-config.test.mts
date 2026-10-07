import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

test("test proxy config requires an explicit private file", () => {
  const previous = process.env.OPENGROK_TEST_PROXY_CONFIG;
  delete process.env.OPENGROK_TEST_PROXY_CONFIG;
  try { assert.throws(() => loadTestProxyConfig(), /OPENGROK_TEST_PROXY_CONFIG/); }
  finally {
    if (previous === undefined) delete process.env.OPENGROK_TEST_PROXY_CONFIG;
    else process.env.OPENGROK_TEST_PROXY_CONFIG = previous;
  }
});

test("test proxy config accepts flat and nested JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "opengrok-proxy-config-"));
  const previous = process.env.OPENGROK_TEST_PROXY_CONFIG;
  try {
    for (const [name, value] of [
      ["flat.json", { baseUrl: "http://127.0.0.1:3850/v1", apiKey: "fixture-key" }],
      ["nested.json", { providers: { cliproxy: {
        baseUrl: "http://127.0.0.1:3851/v1", apiKey: "fixture-key-2",
      } } }],
    ] as const) {
      const filename = join(directory, name);
      writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
      process.env.OPENGROK_TEST_PROXY_CONFIG = filename;
      assert.deepEqual(loadTestProxyConfig(),
        name === "flat.json" ? value : value.providers.cliproxy);
    }
  } finally {
    if (previous === undefined) delete process.env.OPENGROK_TEST_PROXY_CONFIG;
    else process.env.OPENGROK_TEST_PROXY_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
