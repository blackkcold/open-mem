import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizedFetch as fetch } from "./http-client.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { startServer, type ServerHandle } from "../src/server.js";
import { newChangeID } from "../src/changes.js";
import { itemContentVersion } from "../src/fingerprint.js";
import type { ChangeEvent, ChangeJournal, Item } from "../src/types.js";

let dir: string;
let store: Store;
let server: ServerHandle;

const source = { sessionID: "s1", messageID: "m1", role: "user" as const };
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_undo",
    title: "偏好",
    text: "旧正文",
    kind: "preference",
    scope: "global",
    status: "auto",
    source,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let oldEvent: ChangeEvent;
let current: Item;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openmem-api-undo-config-"));
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
  const snapshot = item();
  oldEvent = {
    id: newChangeID(),
    at: daysAgo(100),
    kind: "update",
    actor: "user",
    itemID: snapshot.id,
    itemVersion: itemContentVersion(snapshot),
    after: snapshot,
    source,
    origin: "user",
    reason: "historic",
    revertible: true,
  };
  const journal: ChangeJournal = {
    id: oldEvent.id,
    at: oldEvent.at,
    itemID: oldEvent.itemID,
    kind: oldEvent.kind,
    after: oldEvent.after,
    undone: false,
  };
  current = { ...snapshot, text: "现在的正文", changeID: newChangeID() };
  await store.transaction(async () => {
    await store.appendChange(oldEvent);
    await store.writeChangeJournal(journal);
    await store.replaceItems([current]);
  });
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function api(pathname: string): string {
  return `http://127.0.0.1:${server.port}${pathname}${pathname.includes("?") ? "&" : "?"}token=test-token`;
}

async function patchConfig(body: unknown): Promise<Response> {
  return fetch(api("/api/config"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("undo.retainDays is a real setting", () => {
  it("persists through PATCH /api/config and immediately widens restoreVersion", async () => {
    const tooOld = await fetch(api("/api/items/item_undo/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changeID: oldEvent.id, expectedVersion: itemContentVersion(current) }),
    });
    expect(tooOld.status).toBe(409);
    expect(((await tooOld.json()) as { code: string }).code).toBe("not_revertible");

    const patched = await patchConfig({ undo: { retainDays: 200 } });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { undo: { retainDays: number } };
    expect(body.undo.retainDays).toBe(200);
    // Persisted, not just echoed back to this process.
    expect((await store.readConfig()).undo.retainDays).toBe(200);

    const restored = await fetch(api("/api/items/item_undo/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changeID: oldEvent.id,
        expectedVersion: itemContentVersion((await store.listItems())[0]),
      }),
    });
    expect(restored.status).toBe(200);
    expect((await store.listItems())[0].text).toBe("旧正文");
  });

  it("rejects a non-positive retain window instead of silently storing it", async () => {
    const response = await patchConfig({ undo: { retainDays: 0 } });
    expect(response.status).toBe(400);
    expect((await store.readConfig()).undo.retainDays).toBe(200);
  });
});
