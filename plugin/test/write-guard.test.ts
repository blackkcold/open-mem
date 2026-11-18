import { describe, expect, it } from "vitest";
import { itemContentVersion, queueItemSnapshotVersion } from "../src/fingerprint.js";
import { findWriteConflicts } from "../src/memory/write-guard.js";
import type { Item, QueueItem } from "../src/types.js";

const at = "2026-01-01T00:00:00.000Z";

function item(overrides: Partial<Item>): Item {
  return {
    id: "item-1",
    title: "本地端口",
    text: "本地 dev server 端口是 5199",
    kind: "fact",
    scope: "global",
    status: "auto",
    source: {},
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function queueRow(overrides: Partial<QueueItem>): QueueItem {
  return {
    id: "queue-1",
    title: "本地端口",
    text: "本地 dev server 端口是 5198",
    kind: "fact",
    scope: "global",
    status: "queue",
    source: {},
    createdAt: at,
    updatedAt: at,
    reason: "test",
    ...overrides,
  };
}

const candidate = {
  id: "queue-candidate",
  title: "本地端口",
  text: "本地 dev server 端口是 5198",
  kind: "fact" as const,
  scope: "global" as const,
};

describe("findWriteConflicts", () => {
  it("reports a same-scope conflict with the entry content version", () => {
    const existing = item({});
    const result = findWriteConflicts(candidate, [existing]);
    expect(result.unsafe).toBeUndefined();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      id: "item-1",
      relation: "conflict",
      version: itemContentVersion(existing),
    });
    expect(result.conflicts[0]?.reasons.length).toBeGreaterThan(0);
  });

  it("excludes archived rows, the candidate itself and other projects", () => {
    const result = findWriteConflicts(
      { ...candidate, scope: "project", projectKey: "A" },
      [
        item({ id: "archived", status: "archived" }),
        item({ id: "self", projectKey: "A", status: "queue" }),
        item({ id: "other-project", projectKey: "B" }),
      ],
      { excludeID: "self" },
    );
    expect(result.conflicts).toEqual([]);
  });

  it("fails closed when a project candidate has no project key", () => {
    const result = findWriteConflicts({ ...candidate, scope: "project" }, [
      item({ id: "item-1" }),
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.unsafe).toMatch(/projectKey/);
  });

  it("uses the queue snapshot version for a pending entry", () => {
    const pending = queueRow({ id: "queue-2" });
    const result = findWriteConflicts(
      { ...candidate, text: "本地 dev server 端口是 5199" },
      [pending],
    );
    expect(result.conflicts[0]?.version).toBe(queueItemSnapshotVersion(pending));
  });

  it("orders conflict before covered", () => {
    const result = findWriteConflicts(
      { ...candidate, text: "本地端口是 5198，使用 nohup" },
      [
        item({
          id: "covered",
          text: "本地端口是 5198，使用 nohup 并检查端口",
        }),
        item({ id: "conflict", text: "本地端口是 5199，使用 nohup" }),
      ],
    );
    expect(result.conflicts.map((entry) => entry.id)).toEqual(["conflict", "covered"]);
    expect(result.conflicts.map((entry) => entry.relation)).toEqual(["conflict", "covered"]);
  });
});
