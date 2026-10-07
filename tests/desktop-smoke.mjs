import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: process.env.OPENGROK_TEST_CHROMIUM_EXECUTABLE || undefined, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
  await page.goto("http://127.0.0.1:5173/");
  const result = await page.evaluate(async () => {
    const { default: RFB } = await import("/node_modules/.vite/deps/@novnc_novnc.js");
    const target = document.createElement("div");
    target.style.cssText = "position:fixed;inset:0;background:#fff;z-index:9999";
    document.body.append(target);
    const rfb = new RFB(target, "ws://127.0.0.1:6080");
    rfb.scaleViewport = true;
    rfb.viewOnly = true;
    await new Promise((resolve, reject) => {
      rfb.addEventListener("connect", resolve, { once: true });
      rfb.addEventListener("disconnect", () => reject(new Error("VNC disconnected")), { once: true });
      setTimeout(() => reject(new Error("VNC timeout")), 10000);
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const canvas = target.querySelector("canvas");
    if (!canvas) throw new Error("noVNC canvas missing");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let nonblank = 0;
    for (let offset = 0; offset < pixels.length; offset += 400) {
      if (pixels[offset] !== 255 || pixels[offset + 1] !== 255 || pixels[offset + 2] !== 255) nonblank += 1;
    }
    return { connected: true, width: canvas.width, height: canvas.height, nonblank };
  });
  await page.screenshot({ path: ".local/desktop-smoke.png", fullPage: true });
  console.log(JSON.stringify(result));
  if (result.nonblank < 100) process.exitCode = 1;
} finally {
  await browser.close();
}
