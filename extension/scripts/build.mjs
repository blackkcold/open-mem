import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The browser bundles and the esbuild dependency live in console/. Keep this
// wrapper so `node extension/scripts/build.mjs` still works from the package.
const here = path.dirname(fileURLToPath(import.meta.url));
const consoleRoot = path.resolve(here, "..", "..", "console");
const result = spawnSync("node", ["scripts/build-extension.mjs"], {
  cwd: consoleRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
