import { run } from "./runtime.mjs";
await run(process.env.PYTHON || "python", ["-m", "unittest", "discover", "-s", "tests"]);
