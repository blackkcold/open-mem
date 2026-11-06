import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { authorizedFetch as fetch } from "./http-client.js";

describe("scope migration API", () => {
  it("requires a previewID and consumes it before writing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-migration-api-"));
    const store = new Store(dir);
    await store.init();
    const at = new Date().toISOString();
    await store.upsertQueue({
      id: "q1",
      title: "任务约束",
      text: "MUST NOT DO: Modify files.",
      kind: "rule",
      scope: "global",
      status: "queue",
      source: {},
      createdAt: at,
      updatedAt: at,
      reason: "test",
    });
    const server = await startServer({
      store,
      config: mergeConfig(DEFAULT_CONFIG, { console: false }),
      token: "migration-token",
      port: 0,
      consoleDir: path.join(dir, "no-console"),
    });
    const api = (pathname: string) =>
      `http://127.0.0.1:${server.port}${pathname}${
        pathname.includes("?") ? "&" : "?"
      }token=migration-token`;
    try {
      const previewResponse = await fetch(api("/api/migrations/scopes/preview"));
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()) as { previewID?: string };
      expect(preview.previewID).toBeTruthy();

      const missing = await fetch(api("/api/migrations/scopes/apply"), {
        method: "POST",
        body: JSON.stringify({ confirmedByUser: true }),
      });
      expect(missing.status).toBe(409);
      expect((await store.listQueue())[0].scope).toBe("global");

      const applied = await fetch(api("/api/migrations/scopes/apply"), {
        method: "POST",
        body: JSON.stringify({
          confirmedByUser: true,
          previewID: preview.previewID,
        }),
      });
      expect(applied.status).toBe(200);
      expect((await store.listQueue())[0].scope).toBe("session");

      const replay = await fetch(api("/api/migrations/scopes/apply"), {
        method: "POST",
        body: JSON.stringify({
          confirmedByUser: true,
          previewID: preview.previewID,
        }),
      });
      expect(replay.status).toBe(409);
      expect((await store.listQueue())[0].scope).toBe("session");
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
