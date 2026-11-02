import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, runtime, run, env } from "./runtime.mjs";

const mode = process.argv[2] || "dev";
if (!["dev", "build"].includes(mode)) throw new Error("Expected dev or build");
const cli = join(root, "desktop/node_modules/@tauri-apps/cli/tauri.js");
if (!existsSync(cli)) throw new Error("Run npm run setup first");
const config = { build: { frontendDist: env.SVM_FRONTEND_DIST } };
if (mode === "build") {
  const workerDist = join(runtime, "worker-dist");
  await run(process.env.PYTHON || "python", ["-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "short-video-moderation-worker", "--paths", root,
    "--collect-data", "short_video_moderation", "--collect-all", "faster_whisper",
    "--distpath", workerDist, "--workpath", join(runtime, "worker-build"), "--specpath", runtime,
    join(root, "scripts/worker_launcher.py")]);
  config.bundle = { resources: { [join(workerDist, "short-video-moderation-worker")]: "worker" } };
}
const configPath = join(runtime, `tauri-${mode}.json`);
writeFileSync(configPath, JSON.stringify(config));
await run(process.execPath, [cli, mode, "--config", configPath], join(root, "desktop"));
