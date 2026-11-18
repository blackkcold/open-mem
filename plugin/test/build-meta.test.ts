import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const json = <T>(relative: string): T => JSON.parse(source(relative)) as T;

describe("build metadata", () => {
  it("keeps the extension manifest on the console version", () => {
    const consolePackage = json<{ version: string }>("../../console/package.json");
    const extensionPackage = json<{ version: string }>(
      "../../extension/package.json",
    );
    expect(extensionPackage.version.split("+")[0]).toBe(consolePackage.version);
  });

  it("injects the app version and build timestamp into both builds", () => {
    const vite = source("../../console/vite.config.ts");
    const esbuild = source("../../console/scripts/build-extension.mjs");
    for (const build of [vite, esbuild]) {
      expect(build).toContain("__APP_VERSION__");
      expect(build).toContain("__BUILD_TIME__");
    }
  });

  it("derives the packaged extension version and timestamp from the console package", () => {
    const packager = source("../../console/scripts/package-extension.mjs");
    expect(packager).toContain("consoleRoot");
    expect(packager).toContain("appVersion");
    expect(packager).toContain("buildTime");
    expect(packager).toContain("+build.");
  });
});
