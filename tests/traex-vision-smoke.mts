import { randomInt, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { generateAgentStep } from "../packages/core/src/model.ts";
import { loadTestProxyConfig } from "./test-proxy-config.mts";

const proxy = loadTestProxyConfig();
const apiKey = proxy.apiKey;
const expected = String(randomInt(100000, 1000000));
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined });
let image: Buffer;
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 240 } });
  await page.setContent('<canvas width="640" height="240"></canvas>');
  await page.evaluate(code => {
    const context = document.querySelector("canvas")!.getContext("2d")!;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, 640, 240);
    context.fillStyle = "#151515";
    context.font = "bold 100px monospace";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(code, 320, 120);
  }, expected);
  image = await page.locator("canvas").screenshot();
} finally {
  await browser.close();
}

const output = await generateAgentStep({
  id: randomUUID(), name: "TraeX Gemini vision smoke", provider: "openai-compatible",
  modelId: "traex/Gemini-3-Flash-Preview", baseUrl: proxy.baseUrl, apiKey,
  hasApiKey: true, createdAt: new Date().toISOString(),
  capabilities: { text: true, tools: false, vision: true, streaming: true },
}, {
  system: "你只读取图片中的数字。无法确定时回答 UNKNOWN。",
  messages: [{ role: "user", content: [
    { type: "text", text: "请只返回图片中央的六位数字，不要添加其他内容。" },
    { type: "file", data: { type: "data", data: image }, mediaType: "image/png" },
  ] }],
  signal: new AbortController().signal, capabilities: [],
  maxOutputTokens: 150, maxCallMs: 120_000,
});
const actual = output.text.trim().replace(/[^0-9]/g, "");
console.log(JSON.stringify({ modelId: "traex/Gemini-3-Flash-Preview", expected, actual,
  imageBytes: image.length, usage: output.usage, passed: actual === expected }));
if (actual !== expected) process.exitCode = 1;
