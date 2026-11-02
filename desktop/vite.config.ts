import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { homedir } from "node:os";
import { join } from "node:path";

const cache = process.env.SVM_CACHE_ROOT || (process.platform === "win32" ? "D:/Codex data/home/.cache" : join(homedir(), ".cache"));
const runtime = process.env.SVM_RUNTIME_ROOT || (process.platform === "win32" ? "D:/Codex data/tmp/short-video-moderation" : join(cache, "short-video-moderation/runtime"));

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5174, strictPort: true },
  build: { outDir: process.env.SVM_FRONTEND_DIST || join(runtime, "frontend-dist"), emptyOutDir: true },
});
