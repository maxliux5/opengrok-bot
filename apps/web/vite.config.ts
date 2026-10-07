import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.OPENGROK_API_TARGET || "http://127.0.0.1:3840";
const proxy = {
  "/api": apiTarget,
  "/desktop": { target: apiTarget.replace(/^http/, "ws"), ws: true },
};
const tls = process.env.OPENGROK_TLS_KEY && process.env.OPENGROK_TLS_CERT ? {
  key: readFileSync(process.env.OPENGROK_TLS_KEY),
  cert: readFileSync(process.env.OPENGROK_TLS_CERT),
} : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    watch: { usePolling: true, interval: 1000 },
    proxy,
  },
  preview: { host: "127.0.0.1", port: 8443, strictPort: true, https: tls, proxy },
});
