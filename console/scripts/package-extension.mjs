import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const consoleRoot = path.resolve(here, "..");
const repoRoot = path.resolve(consoleRoot, "..");
const extensionRoot = path.join(repoRoot, "extension");
const distRoot = path.join(repoRoot, "dist");

const version = JSON.parse(
  readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
).version;
const zipPath = path.join(
  distRoot,
  `openmem-console-extension-${version}.zip`,
);

const build = spawnSync(process.execPath, ["scripts/build-extension.mjs"], {
  cwd: consoleRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

await mkdir(distRoot, { recursive: true });
await rm(zipPath, { force: true });

const files = ["package.json", "README.md", "panel", "page", "status", "service"];
const zip = spawnSync("zip", ["-X", "-r", zipPath, ...files], {
  cwd: extensionRoot,
  stdio: "inherit",
});
if (zip.error) {
  console.error(zip.error);
  process.exit(1);
}
if (zip.status !== 0) process.exit(zip.status ?? 1);

console.log(`\nPackage: ${zipPath}`);
