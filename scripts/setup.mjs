import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { root, runtime, run, windows } from "./runtime.mjs";

const dependencies = join(runtime, "frontend-dependencies");
mkdirSync(dependencies, { recursive: true });
for (const name of ["package.json", "package-lock.json"]) copyFileSync(join(root, "desktop", name), join(dependencies, name));
await run(process.execPath, [process.env.npm_execpath, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], dependencies);
const link = join(root, "desktop/node_modules");
const target = join(dependencies, "node_modules");
if (!existsSync(link)) symlinkSync(target, link, windows ? "junction" : "dir");
else if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(target)) {
  throw new Error(`Existing ${link} does not point to ${target}. Move it aside before setup.`);
}
console.log(`Frontend dependencies ready: ${target}`);
