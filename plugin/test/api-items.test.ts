import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorizedFetch as fetch } from "./http-client.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { startServer, type ServerHandle } from "../src/server.js";
import { newChangeID, recordChange } from "../src/changes.js";
import { itemContentVersion } from "../src/fingerprint.js";
import type { ChangeEvent, Item } from "../src/types.js";

let dir: string;
let store: Store;
let server: ServerHandle;

const now = new Date().toISOString();
const source = { sessionID: "s1", messageID: "m1", role: "user" as const };

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_api",
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

let seeded: Item;
let addEvent: ChangeEvent;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openmem-api-items-"));
  store = new Store(dir);
  await store.init();
  const config = mergeConfig(DEFAULT_CONFIG, { console: false, shadow: false });
  server = await startServer({
    store,
    config,
    token: "test-token",
    port: 0,
    consoleDir: path.join(dir, "no-console"),
    projectDir: dir,
  });
  const base = item();
  const changeID = newChangeID();
  seeded = { ...base, changeID };
  addEvent = await store.transaction(async () => {
    await store.appendItem(seeded);
    return recordChange(store, {
      kind: "add",
      actor: "auto",
      itemID: seeded.id,
      item: seeded,
      source,
      origin: "turn",
      reason: "auto",
    });
  });
  await store.replaceItems([...(await store.listItems()), item({ id: "item_arch", text: "已归档", status: "archived" })]);
});

afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function api(pathname: string): string {
  return `http://127.0.0.1:${server.port}${pathname}${pathname.includes("?") ? "&" : "?"}token=test-token`;
}

function post(pathname: string, body: unknown): Promise<Response> {
  return fetch(api(pathname), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("memory items API", () => {
  it("keeps the legacy /api/items response shape byte-compatible", async () => {
    const response = await fetch(api("/api/items"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["items"]);
    const rows = body.items as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    expect(rows[0]).not.toHaveProperty("version");
    expect(rows[0]).not.toHaveProperty("latestChange");
    expect(rows.map((row) => row.id).sort()).toEqual(["item_api", "item_arch"]);
  });

  it("serves the versioned envelope only on /api/memory/items", async () => {
    const body = (await (await fetch(api("/api/memory/items"))).json()) as {
      items: Array<Item & { version: string; latestChange?: ChangeEvent; revertible: boolean }>;
    };
    expect(body.items).toHaveLength(1);
    const row = body.items[0];
    expect(row.id).toBe("item_api");
    expect(row.version).toBe(itemContentVersion(seeded));
    expect(row.latestChange?.id).toBe(addEvent.id);
    expect(row.revertible).toBe(true);
    expect(row.source).toEqual(source);

    const archived = (await (await fetch(api("/api/memory/items?includeArchived=true"))).json()) as {
      items: Item[];
    };
    expect(archived.items.map((entry) => entry.id).sort()).toEqual(["item_api", "item_arch"]);
    const filtered = (await (await fetch(api("/api/memory/items?status=archived&includeArchived=true"))).json()) as {
      items: Item[];
    };
    expect(filtered.items.map((entry) => entry.id)).toEqual(["item_arch"]);
    const searched = (await (await fetch(api("/api/memory/items?q=结论"))).json()) as { items: Item[] };
    expect(searched.items.map((entry) => entry.id)).toEqual(["item_api"]);
  });

  it("requires a token for every memory route", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    for (const [pathname, method] of [
      ["/api/items", "GET"],
      ["/api/memory/items", "GET"],
      ["/api/changes", "GET"],
      ["/api/items/item_api/changes", "GET"],
      ["/api/items/item_api/deactivate", "POST"],
      ["/api/items/item_api/revert", "POST"],
      ["/api/items/item_api/restore", "POST"],
      ["/api/items/item_api/reactivate", "POST"],
    ] as Array<[string, string]>) {
      const response = await fetch(`${base}${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ expectedVersion: "x" }) } : {}),
      });
      expect([pathname, response.status]).toEqual([pathname, 401]);
    }
  });

  it("lists change events for one item and refuses an unknown item", async () => {
    const response = await fetch(api("/api/items/item_api/changes"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { changes: ChangeEvent[] };
    expect(body.changes.map((event) => event.id)).toEqual([addEvent.id]);
    expect((await fetch(api("/api/items/nope/changes"))).status).toBe(404);
    const ledger = (await (await fetch(api("/api/changes?limit=5"))).json()) as { changes: ChangeEvent[] };
    expect(ledger.changes.some((event) => event.id === addEvent.id)).toBe(true);
  });

  it("returns 409 plus the current version for a stale expectedVersion and writes nothing", async () => {
    const before = await store.listChanges();
    const response = await post("/api/items/item_api/deactivate", {
      expectedVersion: "stale",
      reason: "test",
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; version: string };
    expect(body.code).toBe("version_mismatch");
    expect(body.version).toBe(itemContentVersion(seeded));
    expect(await store.listChanges()).toHaveLength(before.length);
    expect((await store.listItems()).find((entry) => entry.id === "item_api")?.status).toBe("auto");
  });

  it("stops and resumes use through the API, ignoring a body source", async () => {
    const current = (await store.listItems()).find((entry) => entry.id === "item_api") as Item;
    const stopped = await post("/api/items/item_api/deactivate", {
      expectedVersion: itemContentVersion(current),
      source: { sessionID: "forged", messageID: "forged" },
      reason: "no longer true",
    });
    expect(stopped.status).toBe(200);
    const stoppedBody = (await stopped.json()) as { ok: boolean; event: ChangeEvent };
    expect(stoppedBody.event.kind).toBe("deactivate");
    expect(stoppedBody.event.source).toEqual(source);
    expect(
      (await (await fetch(api("/api/memory/items?includeArchived=true"))).json() as { items: Item[] }).items
        .find((entry) => entry.id === "item_api")?.status,
    ).toBe("archived");

    const stoppedRow = (await store.listItems()).find((entry) => entry.id === "item_api") as Item;
    const resumed = await post("/api/items/item_api/reactivate", {
      expectedVersion: itemContentVersion(stoppedRow),
    });
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { event: ChangeEvent }).event.kind).toBe("restore");
    expect((await store.listItems()).find((entry) => entry.id === "item_api")?.status).toBe("auto");
  });

  it("reverts a change and refuses an unsafe text-only restore", async () => {
    const fresh: Item = item({ id: "item_rv", text: "可以被撤销的偏好" });
    const changeID = newChangeID();
    const written = { ...fresh, changeID };
    const event = await store.transaction(async () => {
      await store.appendItem(written);
      return recordChange(store, {
        kind: "add",
        actor: "auto",
        itemID: written.id,
        item: written,
        source,
        origin: "turn",
        reason: "auto",
      });
    });
    const reverted = await post("/api/items/item_rv/revert", {
      changeID: event.id,
      expectedVersion: itemContentVersion(written),
    });
    expect(reverted.status).toBe(200);
    const row = (await store.listItems()).find((entry) => entry.id === "item_rv") as Item;
    expect(row.status).toBe("archived");

    // The add has no before snapshot, so it archives; it cannot fake a body.
    const restored = await post("/api/items/item_rv/restore", {
      changeID: event.id,
      expectedVersion: itemContentVersion(row),
    });
    expect(restored.status).toBe(200);
    const back = (await store.listItems()).find((entry) => entry.id === "item_rv") as Item;
    expect(back.status).toBe("auto");
    expect(back.text).toBe("可以被撤销的偏好");
  });

  it("refuses to revert another item's change through the wrong route id", async () => {
    const seedOne = async (id: string, text: string) => {
      const base = item({ id, text });
      const changeID = newChangeID();
      const written = { ...base, changeID };
      const event = await store.transaction(async () => {
        await store.appendItem(written);
        return recordChange(store, {
          kind: "add", actor: "auto", itemID: written.id, item: written,
          source, origin: "turn", reason: "auto",
        });
      });
      return { written, event };
    };
    const a = await seedOne("item_a_route", "A 的偏好");
    const b = await seedOne("item_b_route", "B 的偏好");
    const response = await post("/api/items/item_a_route/revert", {
      changeID: b.event.id,
      expectedVersion: itemContentVersion(a.written),
    });
    expect(response.status).toBe(404);
    const untouched = (await store.listItems()).find((entry) => entry.id === "item_b_route");
    expect(untouched?.status).toBe("auto");
    expect(untouched?.invalidatedBy).toBeUndefined();
    expect(
      (await store.listChanges()).filter((event) => event.itemID === "item_b_route"),
    ).toHaveLength(1);
  });

  it("maps an unknown change to 404 and a non-revertible one to 409", async () => {
    const current = (await store.listItems()).find((entry) => entry.id === "item_api") as Item;
    const missing = await post("/api/items/item_api/revert", {
      changeID: "change_missing",
      expectedVersion: itemContentVersion(current),
    });
    expect(missing.status).toBe(404);

    const changes = await store.listChanges({ itemID: "item_api" });
    const notRevertible = [...changes].reverse().find((event) => !event.revertible);
    expect(notRevertible).toBeTruthy();
    const response = await post("/api/items/item_api/revert", {
      changeID: notRevertible?.id,
      expectedVersion: itemContentVersion(current),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("not_revertible");
  });

  it("exposes no undo/restore action to the agent tool", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "plugin.ts"), "utf8");
    const block = source.slice(source.indexOf('name: "memory_autopilot"'));
    const enumBlock = block.slice(0, block.indexOf("required:"));
    for (const action of ["deactivate", "reactivate", "revert", "restore"]) {
      expect(enumBlock).not.toContain(`"${action}"`);
    }
  });
});
