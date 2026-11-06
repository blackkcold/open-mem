import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const consoleRoot = path.resolve(here, "..");
const repoRoot = path.resolve(consoleRoot, "..");
const extensionRoot = path.join(repoRoot, "extension");
const distRoot = path.join(repoRoot, "dist");

const consolePackage = JSON.parse(
  readFileSync(path.join(consoleRoot, "package.json"), "utf8"),
);
const manifest = JSON.parse(
  readFileSync(path.join(extensionRoot, "package.json"), "utf8"),
);
const appVersion = consolePackage.version;
const buildTime = process.env.BUILD_TIME ?? new Date().toISOString();
const buildTag = buildTime.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
// Follow the console version automatically; the timestamp makes two builds of
// the same version distinguishable in the OpenChamber extension card.
const version = `${appVersion}+build.${buildTag}`;
const stage = path.join(distRoot, `openmem-console-extension-${appVersion}`);
const zipPath = path.join(
  distRoot,
  `openmem-console-extension-${appVersion}-${buildTag}.zip`,
);

const build = spawnSync(process.execPath, ["scripts/build-extension.mjs"], {
  cwd: consoleRoot,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

await mkdir(distRoot, { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

const files = ["README.md", "panel", "page", "status", "service"];
for (const name of files) {
  await cp(
    path.join(extensionRoot, name),
    path.join(stage, name),
    { recursive: true },
  );
}
await writeFile(
  path.join(stage, "package.json"),
  `${JSON.stringify({ ...manifest, version, buildTime }, null, 2)}\n`,
  "utf8",
);

await rm(zipPath, { force: true });
const zip = spawnSync(
  "zip",
  ["-X", "-r", zipPath, "package.json", ...files],
  { cwd: stage, stdio: "inherit" },
);
if (zip.error) {
  console.error(zip.error);
  process.exit(1);
}
if (zip.status !== 0) process.exit(zip.status ?? 1);

console.log(`\nPackage: ${zipPath}`);
console.log(`Extension version: ${version}`);
console.log(`Build time: ${buildTime}`);
