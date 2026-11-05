import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { ensureConsoleServer, releaseConsoleServer } from "../src/plugin.js";

async function health(port: number, token: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
}

describe("console server lifecycle", () => {
  it("keeps the shared server alive until the last release", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-console-"));
    const store = new Store(dir);
    await store.init();
    const config = mergeConfig({ console: true, port: 0 });
    const options = {
      store,
      config,
      token: "lifecycle-token",
      decisionKeySource: "missing" as const,
      suggest: async () => undefined,
    };
    let handle: Awaited<ReturnType<typeof ensureConsoleServer>> | undefined;
    try {
      handle = await ensureConsoleServer(options);
      const second = await ensureConsoleServer(options);
      expect(second).toBe(handle);
      expect(await health(handle.port, "lifecycle-token")).toBe(200);

      await releaseConsoleServer(dir, 0);
      expect(await health(handle.port, "lifecycle-token")).toBe(200);

      await releaseConsoleServer(dir, 0);
      await expect(health(handle.port, "lifecycle-token")).rejects.toThrow();
    } finally {
      await releaseConsoleServer(dir, 0).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
