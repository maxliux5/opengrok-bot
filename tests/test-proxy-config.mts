import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

type ProxyConfig = { baseUrl: string; apiKey: string };

export function loadTestProxyConfig(): ProxyConfig {
  const filename = process.env.OPENGROK_TEST_PROXY_CONFIG;
  if (!filename) throw new Error("Set OPENGROK_TEST_PROXY_CONFIG to a private JSON config file");
  const document = JSON.parse(readFileSync(filename, "utf8"));
  const proxy = document?.providers?.cliproxy ?? document;
  if (!proxy || typeof proxy.baseUrl !== "string" || !proxy.baseUrl ||
    typeof proxy.apiKey !== "string") {
    throw new Error("Test proxy config requires baseUrl and apiKey strings");
  }
  const apiKey = proxy.apiKey.startsWith("!")
    ? execSync(proxy.apiKey.slice(1), { encoding: "utf8" }).trim() : proxy.apiKey;
  if (!apiKey) throw new Error("Test proxy API key is empty");
  return { baseUrl: proxy.baseUrl, apiKey };
}
