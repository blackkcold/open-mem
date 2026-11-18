import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizedFetch as fetch } from "./http-client.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { startServer, type ServerHandle } from "../src/server.js";
import { applyQueueDecision } from "../src/actions.js";
import { runCompaction } from "../src/compact.js";
import type { Item, QueueItem } from "../src/types.js";

let dir: string;
let store: Store;
let server: ServerHandle;

const source = { sessionID: "s1", messageID: "m1", role: "user" as const };
const now = new Date().toISOString();

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_legacy",
    title: "偏好",
    text: "回复先给结论",
    kind: "preference",
    scope: "global",
    status: "auto",
    source,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queue(id: string, text: string): QueueItem {
  return {
    id,
    title: "偏好",
    text,
    kind: "preference",
    scope: "global",
    status: "queue",
    source,
    createdAt: now,
    updatedAt: now,
    priority: 70,
    priorityBreakdown: { risk: 0.2, impact: 0.9, uncertainty: 0.1, age: 0 },
    reason: "test",
    diff: `+ ${text}`,
    decision: {
      kind: "preference",
      duplicate: 0,
      safeAuto: 0.96,
      risk: 0.1,
      confidence: 0.9,
      strictness: "preference",
      reasons: [],
      source: "heuristic",
      mergeAction: "create",
      conflict: 0,
    },
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openmem-api-legacy-undo-"));
  store = new Store(dir);
  await store.init();
  server = await startServer({
    store,
    config: mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false }),
    token: "test-token",
    port: 0,
    consoleDir: path.join(dir, "no-console"),
    projectDir: dir,
  });
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function api(pathname: string): string {
  return `http://127.0.0.1:${server.port}${pathname}${pathname.includes("?") ? "&" : "?"}token=test-token`;
}

function post(pathname: string): Promise<Response> {
  return fetch(api(pathname), { method: "POST" });
}

describe("legacy queue-recovery undo records exactly one event per changed item", () => {
  it("writes one archive event and no ghost event on a repeated restore", async () => {
    await store.upsertQueue(queue("q_recovery", "回复先给结论"));
    const approved = await applyQueueDecision(store, DEFAULT_CONFIG, "q_recovery", {
      action: "approve",
      confirmedByUser: true,
    });
    expect(approved.ok).toBe(true);
    const recoveryID = String(
      (await store.listChangelog()).find((entry) => entry.action === "approve")?.recoveryID,
    );
    expect(recoveryID).toMatch(/^recovery_/);
    const itemID = (await store.listItems())[0].id;
    const before = (await store.listChanges()).length;

    const restored = await post(`/api/recovery/${recoveryID}/restore`);
    expect(restored.status).toBe(200);
    const events = await store.listChanges();
    const added = events.slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].itemID).toBe(itemID);
    expect(added[0].kind).toBe("archive");
    expect(added[0].before?.status).toBe("auto");
    expect(added[0].after?.status).toBe("archived");
    expect((await store.listItems()).find((entry) => entry.id === itemID)?.status).toBe("archived");

    const ledger = events.length;
    const again = await post(`/api/recovery/${recoveryID}/restore`);
    expect(again.status).toBe(409);
    expect(await store.listChanges()).toHaveLength(ledger);
  });

  it("writes nothing when the recovery record does not exist", async () => {
    const before = (await store.listChanges()).length;
    const response = await post("/api/recovery/recovery_missing/restore");
    expect(response.status).toBe(409);
    expect(await store.listChanges()).toHaveLength(before);
  });
});

describe("legacy maintenance undo records exactly one event per changed item", () => {
  it("writes one event per restored row and nothing on a repeated undo", async () => {
    const canonical = item({ id: "item_mc1", text: "回复先给结论", seenCount: 2 });
    const duplicate = item({
      id: "item_mc2",
      text: "回复先给结论",
      createdAt: new Date(Date.now() + 1).toISOString(),
    });
    await store.replaceItems([canonical, duplicate]);
    const compacted = await runCompaction(store, mergeConfig({}), {});
    expect(compacted.journalID).toMatch(/^maintenance_/);
    const before = (await store.listChanges()).length;

    const undone = await post(`/api/maintenance/${compacted.journalID}/undo`);
    expect(undone.status).toBe(200);
    const added = (await store.listChanges()).slice(before);
    expect(added.map((event) => event.itemID).sort()).toEqual(["item_mc1", "item_mc2"]);
    expect(added.every((event) => event.kind === "revert")).toBe(true);
    const rows = await store.listItems();
    expect(rows.find((entry) => entry.id === "item_mc1")?.text).toBe("回复先给结论");
    expect(rows.find((entry) => entry.id === "item_mc2")?.status).toBe("auto");

    const ledger = (await store.listChanges()).length;
    const again = await post(`/api/maintenance/${compacted.journalID}/undo`);
    expect(again.status).toBe(409);
    expect(await store.listChanges()).toHaveLength(ledger);
  });

  it("writes nothing when the maintenance record does not exist", async () => {
    const before = (await store.listChanges()).length;
    const response = await post("/api/maintenance/maintenance_missing/undo");
    expect(response.status).toBe(409);
    expect(await store.listChanges()).toHaveLength(before);
  });
});
