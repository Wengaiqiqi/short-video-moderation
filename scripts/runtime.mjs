import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const windows = process.platform === "win32";
export const cache = process.env.SVM_CACHE_ROOT || (windows ? "D:/Codex data/home/.cache" : join(homedir(), ".cache"));
export const runtime = process.env.SVM_RUNTIME_ROOT || (windows ? "D:/Codex data/tmp/short-video-moderation" : join(cache, "short-video-moderation/runtime"));
for (const path of [cache, runtime, join(runtime, "tmp")]) mkdirSync(path, { recursive: true });
export const env = {
  ...process.env,
  TEMP: join(runtime, "tmp"), TMP: join(runtime, "tmp"), TMPDIR: join(runtime, "tmp"),
  npm_config_cache: join(cache, "npm"), PIP_CACHE_DIR: join(cache, "pip"),
  CARGO_HOME: join(cache, "cargo"), CARGO_TARGET_DIR: join(cache, "short-video-moderation/target"),
  SVM_RUNTIME_ROOT: runtime, SVM_CACHE_ROOT: cache,
  WEBVIEW2_USER_DATA_FOLDER: join(runtime, "webview"),
  PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1",
  SVM_FRONTEND_DIST: join(runtime, "frontend-dist"),
};

export function run(command, args, cwd = root) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? accept() : reject(new Error(`${command} exited (${code ?? signal})`)));
  });
}
