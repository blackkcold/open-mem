import { describe, expect, it } from "vitest";
import {
  EMPTY_MEMORY_FILTERS,
  canRestore,
  canRevert,
  canStop,
  inTimeWindow,
  matchesFilters,
  segmentCounts,
  segmentOf,
  sourceKindOf,
} from "../../console/src/pages/memory-model.js";
import type { MemoryFilters } from "../../console/src/pages/memory-model.js";
import type { ChangeEvent, MemoryItem } from "../../console/src/types.js";

const item = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: "item-1",
  title: "回复先给结论",
  text: "这个项目回复先给结论",
  kind: "preference",
  scope: "project",
  projectKey: "proj-a",
  status: "auto",
  source: { sessionID: "session-1", messageID: "message-1" },
  createdAt: "2026-11-17T09:00:00.000Z",
  updatedAt: "2026-11-17T09:00:00.000Z",
  version: "v1",
  stoppable: true,
  restorable: false,
  expired: false,
  revertible: false,
  ...overrides,
});

const change = (overrides: Partial<ChangeEvent> = {}): ChangeEvent => ({
  id: "change_1",
  at: "2026-11-17T09:00:00.000Z",
  kind: "update",
  actor: "auto",
  itemID: "item-1",
  source: {},
  reason: "更新内容",
  revertible: false,
  ...overrides,
});

const now = Date.parse("2026-11-18T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(now - ms).toISOString();

const filters = (overrides: Partial<MemoryFilters> = {}): MemoryFilters => ({
  ...EMPTY_MEMORY_FILTERS,
  ...overrides,
});

describe("segmentOf", () => {
  it("puts injected rows in 生效中 and session-scoped rows in 本次会话", () => {
    expect(segmentOf(item())).toBe("active");
    expect(segmentOf(item({ status: "promoted" }))).toBe("active");
    expect(segmentOf(item({ scope: "global" }))).toBe("active");
    expect(segmentOf(item({ scope: "session" }))).toBe("session");
    expect(segmentOf(item({ status: "promoted", scope: "session" }))).toBe("session");
  });

  it("reads a stop from server flags, not from local dates", () => {
    expect(
      segmentOf(item({ status: "archived", supersededBy: "deactivate", restorable: true })),
    ).toBe("stopped");
    expect(segmentOf(item({ status: "archived", supersededBy: "deactivate" }))).toBe(
      "stopped",
    );
    expect(segmentOf(item({ invalidatedBy: "item-0" }))).toBe("stopped");
  });

  it("classifies expired rows, including rows archived by expiry", () => {
    expect(segmentOf(item({ expired: true }))).toBe("expired");
    expect(segmentOf(item({ status: "archived", expired: true, restorable: true }))).toBe(
      "expired",
    );
    expect(
      segmentOf(
        item({
          status: "archived",
          latestChange: change({ kind: "expire", actor: "curator" }),
        }),
      ),
    ).toBe("expired");
  });

  it("keeps an unexplained archive and non-injected statuses in 全部", () => {
    expect(segmentOf(item({ status: "archived" }))).toBe("all");
    expect(segmentOf(item({ status: "queue" }))).toBe("all");
    expect(segmentOf(item({ status: "shadow" }))).toBe("all");
    expect(segmentOf(item({ status: "false_positive" }))).toBe("all");
  });
});

describe("capability flags", () => {
  it("offers stop only when the server marks the row stoppable", () => {
    expect(canStop(item({ stoppable: true }))).toBe(true);
    expect(canStop(item({ stoppable: false }))).toBe(false);
    // The server owns the decision: an archived row that is still reported as
    // stoppable must not be overridden by local status reasoning.
    expect(canStop(item({ status: "archived", stoppable: true }))).toBe(true);
  });

  it("offers restore only when the server marks the row restorable", () => {
    expect(
      canRestore(item({ status: "archived", supersededBy: "deactivate", restorable: true })),
    ).toBe(true);
    expect(
      canRestore(item({ status: "archived", supersededBy: "deactivate", restorable: false })),
    ).toBe(false);
    expect(canRestore(item({ restorable: false }))).toBe(false);
  });

  it("offers version rollback only when the change itself is revertible", () => {
    expect(canRevert(undefined)).toBe(false);
    expect(canRevert(change({ revertible: false }))).toBe(false);
    expect(canRevert(change({ revertible: true }))).toBe(true);
  });
});

describe("sourceKindOf", () => {
  it("prefers an explicit manual mark over any recorded change", () => {
    expect(
      sourceKindOf(
        item({
          manual: true,
          latestChange: change({ kind: "migration", actor: "migration", origin: "migration" }),
        }),
      ),
    ).toBe("manual");
  });

  it("labels migration changes as 迁移", () => {
    expect(sourceKindOf(item({ latestChange: change({ kind: "migration" }) }))).toBe(
      "migration",
    );
    expect(
      sourceKindOf(item({ latestChange: change({ kind: "add", origin: "migration" }) })),
    ).toBe("migration");
  });

  it("labels session-review rows as 复盘", () => {
    expect(sourceKindOf(item({ origin: "session-review" }))).toBe("review");
    expect(sourceKindOf(item({ reviewType: "preference", origin: undefined }))).toBe(
      "review",
    );
  });

  it("falls back to 自动 for capture rows and rows without provenance", () => {
    expect(sourceKindOf(item({ source: { sessionID: "session-1" } }))).toBe("auto");
    expect(sourceKindOf(item({ source: { messageID: "message-1" } }))).toBe("auto");
    expect(sourceKindOf(item({ source: {} }))).toBe("auto");
  });
});

describe("inTimeWindow", () => {
  it("keeps every row inside the unbounded window", () => {
    expect(inTimeWindow(item({ updatedAt: ago(400 * DAY) }), "any", now)).toBe(true);
    expect(inTimeWindow(item({ updatedAt: "not-a-date" }), "any", now)).toBe(true);
  });

  it("applies the 24h, 7d and 30d windows to the last update", () => {
    expect(inTimeWindow(item({ updatedAt: ago(23 * HOUR) }), "24h", now)).toBe(true);
    expect(inTimeWindow(item({ updatedAt: ago(25 * HOUR) }), "24h", now)).toBe(false);
    expect(inTimeWindow(item({ updatedAt: ago(6 * DAY) }), "7d", now)).toBe(true);
    expect(inTimeWindow(item({ updatedAt: ago(8 * DAY) }), "7d", now)).toBe(false);
    expect(inTimeWindow(item({ updatedAt: ago(29 * DAY) }), "30d", now)).toBe(true);
    expect(inTimeWindow(item({ updatedAt: ago(31 * DAY) }), "30d", now)).toBe(false);
  });

  it("falls back to the creation time and rejects unparsable dates", () => {
    expect(inTimeWindow(item({ updatedAt: "", createdAt: ago(2 * HOUR) }), "24h", now)).toBe(
      true,
    );
    expect(inTimeWindow(item({ updatedAt: "not-a-date" }), "30d", now)).toBe(false);
  });
});

describe("matchesFilters", () => {
  it("defaults to the active segment, so session rows stay hidden", () => {
    expect(matchesFilters(item(), EMPTY_MEMORY_FILTERS, now)).toBe(true);
    expect(matchesFilters(item({ scope: "session" }), EMPTY_MEMORY_FILTERS, now)).toBe(false);
    expect(
      matchesFilters(item({ scope: "session" }), filters({ segment: "session" }), now),
    ).toBe(true);
  });

  it("combines scope, kind, source and time filters", () => {
    const recent = item({
      scope: "project",
      kind: "preference",
      manual: true,
      updatedAt: ago(2 * HOUR),
    });
    expect(
      matchesFilters(
        recent,
        filters({ scope: "project", kind: "preference", source: "manual", time: "24h" }),
        now,
      ),
    ).toBe(true);
    expect(matchesFilters(recent, filters({ scope: "global" }), now)).toBe(false);
    expect(matchesFilters(recent, filters({ kind: "rule" }), now)).toBe(false);
    expect(matchesFilters(recent, filters({ source: "auto" }), now)).toBe(false);
    expect(
      matchesFilters(item({ updatedAt: ago(20 * DAY) }), filters({ time: "7d" }), now),
    ).toBe(false);
  });

  it("searches title and text case-insensitively after trimming", () => {
    const searchable = item({
      title: "Output Style",
      text: "Reply with conclusions first",
    });
    expect(matchesFilters(searchable, filters({ query: "  style " }), now)).toBe(true);
    expect(matchesFilters(searchable, filters({ query: "CONCLUSIONS" }), now)).toBe(true);
    expect(matchesFilters(searchable, filters({ query: "missing" }), now)).toBe(false);
  });

  it("hides rows outside the selected segment even when other filters match", () => {
    const stopped = item({
      status: "archived",
      supersededBy: "deactivate",
      restorable: true,
    });
    expect(matchesFilters(stopped, filters({ segment: "active" }), now)).toBe(false);
    expect(matchesFilters(stopped, filters({ segment: "stopped" }), now)).toBe(true);
    expect(matchesFilters(stopped, filters({ segment: "all" }), now)).toBe(true);
  });
});

describe("segmentCounts", () => {
  it("counts each named segment and reports the total only under 全部", () => {
    const counts = segmentCounts([
      item({ id: "active-1" }),
      item({ id: "session-1", scope: "session" }),
      item({ id: "stopped-1", status: "archived", supersededBy: "deactivate" }),
      item({ id: "expired-1", expired: true }),
      item({ id: "legacy-1", status: "queue" }),
    ]);
    expect(counts).toEqual({ active: 1, session: 1, stopped: 1, expired: 1, all: 5 });
  });

  it("returns zeros for an empty list", () => {
    expect(segmentCounts([])).toEqual({
      active: 0,
      session: 0,
      stopped: 0,
      expired: 0,
      all: 0,
    });
  });
});
