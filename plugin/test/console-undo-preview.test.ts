import { describe, expect, it } from "vitest";
import { ApiError } from "../../console/src/api";
import {
  buildMergeUndoPreview,
  canApplyLoadRequest,
  canClearUnknownLocks,
  createLoadRequestGate,
  invalidateLoadRequests,
  isUnknownOutcome,
  loadMergeUndoLocks,
  lockMergeUndoUnknown,
  MERGE_UNDO_LOCKS_KEY,
  parseMergeUndoLocks,
  reconcileMergeUndoUnknown,
  resolveMergeUndoLocks,
  RESUME_UNDO_NOTICE,
  saveMergeUndoLocks,
  serializeMergeUndoLocks,
  SESSION_ONLY_UNKNOWN_NOTICE,
  shouldWarnBeforeUnload,
  startLoadRequest,
  syncMergeUndoLeaveWarning,
  unlockMergeUndoUnknown,
  UNSAVED_UNKNOWN_LEAVE_NOTICE,
  type MergeUndoLeaveEvent,
  type MergeUndoLeaveListener,
  type MergeUndoLeaveTarget,
  type MergeUndoLocks,
  type MergeUndoLockStorage,
} from "../../console/src/pages/undo-preview";
import type { MergeJournal } from "../../console/src/types";

const nowMs = Date.parse("2026-11-05T12:00:00.000Z");
const hour = 60 * 60 * 1000;

function at(offsetMs: number): string {
  return new Date(nowMs + offsetMs).toISOString();
}

function journal(overrides: Partial<MergeJournal> = {}): MergeJournal {
  const base: MergeJournal = {
    id: "merge_1",
    at: at(-hour),
    action: "merge_into",
    queueID: "queue_1",
    targetID: "item_target",
    before: {
      queue: { title: "候选标题", text: "候选正文" },
      target: { id: "item_target", title: "目标标题", text: "目标正文" },
    },
    after: {
      target: { id: "item_target", title: "合并后标题", text: "合并后正文" },
    },
  };
  return { ...base, ...overrides };
}

function createdJournal(action: "create" | "keep_both"): MergeJournal {
  return journal({
    action,
    targetID: undefined,
    before: { queue: { title: "候选标题", text: "候选正文" } },
    after: {
      itemID: "item_new",
      item: { id: "item_new", title: "新条目", text: "新正文" },
    },
  });
}

describe("merge undo preview", () => {
  it("describes create as archiving the new entry, never restoring a target", () => {
    const preview = buildMergeUndoPreview(createdJournal("create"), { now: nowMs });
    const effects = preview.effects.join(" ");

    expect(preview.actionLabel).toBe("新建记忆");
    expect(preview.candidate?.title).toBe("候选标题");
    expect(preview.created?.title).toBe("新条目");
    expect(preview.targetBefore).toBeNull();
    expect(preview.restoresTarget).toBe(false);
    expect(preview.archivesCreated).toBe(true);
    expect(effects).toContain("归档本次新建条目");
    expect(effects).not.toContain("恢复目标");
    expect(preview.status).toBe("undoable");
    expect(preview.canUndo).toBe(true);
  });

  it("describes keep_both the same way instead of claiming a target restore", () => {
    const preview = buildMergeUndoPreview(createdJournal("keep_both"), { now: nowMs });
    const effects = preview.effects.join(" ");

    expect(preview.actionLabel).toBe("保留两者");
    expect(preview.restoresTarget).toBe(false);
    expect(preview.archivesCreated).toBe(true);
    expect(effects).toContain("归档本次新建条目");
    expect(effects).not.toContain("恢复目标");
  });

  it("does not invent a target restore for keep_both without an after target", () => {
    const preview = buildMergeUndoPreview(
      journal({
        action: "keep_both",
        before: {
          queue: { title: "候选标题", text: "候选正文" },
          target: { id: "item_target", title: "目标标题", text: "目标正文" },
        },
        after: {
          itemID: "item_new",
          item: { id: "item_new", title: "新条目", text: "新正文" },
        },
      }),
      { now: nowMs },
    );

    expect(preview.restoresTarget).toBe(false);
    expect(preview.safe).toBe(false);
    expect(preview.canUndo).toBe(false);
    expect(preview.effects.join(" ")).not.toContain("恢复目标");
    expect(preview.missing.join(" ")).toContain("after.target");
  });

  it("shows the real target snapshots for merge_into and says it restores them", () => {
    const preview = buildMergeUndoPreview(journal(), { now: nowMs });
    const effects = preview.effects.join(" ");

    expect(preview.actionLabel).toBe("并入目标");
    expect(preview.targetBefore).toEqual({
      id: "item_target",
      title: "目标标题",
      text: "目标正文",
    });
    expect(preview.targetAfter).toEqual({
      id: "item_target",
      title: "合并后标题",
      text: "合并后正文",
    });
    expect(preview.restoresTarget).toBe(true);
    expect(preview.archivesCreated).toBe(false);
    expect(effects).toContain("恢复目标条目「目标标题」到操作前内容");
    expect(effects).toContain("候选「候选标题」回到审批队列");
    expect(effects).not.toContain("归档本次新建");
  });

  it("shows replace before/after and only promises the target restore", () => {
    const preview = buildMergeUndoPreview(
      journal({
        action: "replace",
        before: {
          queue: { title: "候选标题", text: "候选正文" },
          target: { id: "item_target", title: "旧目标", text: "旧目标正文" },
        },
        after: {
          target: { id: "item_target", title: "替换后目标", text: "替换后正文" },
        },
      }),
      { now: nowMs },
    );
    const effects = preview.effects.join(" ");

    expect(preview.actionLabel).toBe("替换目标");
    expect(preview.targetBefore?.title).toBe("旧目标");
    expect(preview.targetAfter?.title).toBe("替换后目标");
    expect(preview.restoresTarget).toBe(true);
    expect(preview.archivesCreated).toBe(false);
    expect(effects).toContain("恢复目标条目「旧目标」到操作前内容");
    expect(effects).not.toContain("归档本次新建");
  });

  it("marks a legacy journal without after snapshots as unsafe to preview", () => {
    const legacy = buildMergeUndoPreview(
      journal({
        action: "create",
        targetID: undefined,
        before: { queue: { title: "候选标题", text: "候选正文" } },
        after: {},
      }),
      { now: nowMs },
    );

    expect(legacy.safe).toBe(false);
    expect(legacy.status).toBe("unsafe");
    expect(legacy.statusLabel).toContain("不可安全");
    expect(legacy.canUndo).toBe(false);
    expect(legacy.missing.length).toBeGreaterThan(0);
    expect(legacy.effects.join(" ")).not.toContain("恢复");
  });

  it("marks a merge journal without its after target as unsafe", () => {
    const legacy = buildMergeUndoPreview(
      journal({ after: {} }),
      { now: nowMs },
    );

    expect(legacy.safe).toBe(false);
    expect(legacy.missing.join(" ")).toContain("after.target");
    expect(legacy.canUndo).toBe(false);
  });

  it("reports an expired window without promising a server-side success", () => {
    const preview = buildMergeUndoPreview(journal({ at: at(-25 * hour) }), { now: nowMs });

    expect(preview.status).toBe("expired");
    expect(preview.statusLabel).toBe("已过期");
    expect(preview.canUndo).toBe(false);
    expect(preview.deadline).toContain("超过 24 小时");
    expect(preview.deadline).toContain("服务端");
  });

  it("reports an already undone journal and disables undo", () => {
    const preview = buildMergeUndoPreview(journal({ undone: true }), { now: nowMs });

    expect(preview.status).toBe("undone");
    expect(preview.statusLabel).toBe("已撤销");
    expect(preview.canUndo).toBe(false);
  });

  it("labels the window as a local estimate checked by the server", () => {
    const preview = buildMergeUndoPreview(journal(), { now: nowMs });

    expect(preview.remainingMs).not.toBeNull();
    expect(preview.remainingMs ?? 0).toBeGreaterThan(22 * hour);
    expect(preview.remainingMs ?? 0).toBeLessThan(24 * hour);
    expect(preview.deadline).toContain("本地");
    expect(preview.deadline).toContain("服务端");
  });

  it("keeps an unknown outcome locked until the user explicitly unlocks it", () => {
    const unknownSince = at(-hour);
    const preview = buildMergeUndoPreview(journal(), { now: nowMs, unknownSince });

    expect(preview.status).toBe("unknown");
    expect(preview.statusLabel).toBe("状态未知");
    expect(preview.canUndo).toBe(false);
    expect(preview.unknownSince).toBe(unknownSince);
    expect(preview.deadline).toContain("可能已提交");
    expect(preview.deadline).toContain("刷新");
  });

  it("does not allow undo when the journal timestamp cannot be parsed", () => {
    const preview = buildMergeUndoPreview(journal({ at: "not-a-date" }), { now: nowMs });

    expect(preview.timeKnown).toBe(false);
    expect(preview.status).toBe("unsafe");
    expect(preview.statusLabel).toBe("时间未知");
    expect(preview.canUndo).toBe(false);
    expect(preview.deadline).toContain("无法解析");
    expect(preview.deadline).toContain("24 小时");
  });

  it("offers a deliberate resume for an interrupted undo past the window", () => {
    const preview = buildMergeUndoPreview(
      journal({ undoing: true, at: at(-30 * hour) }),
      { now: nowMs },
    );

    expect(preview.status).toBe("in-progress");
    expect(preview.statusLabel).toBe("撤销未完成");
    expect(preview.canUndo).toBe(false);
    expect(preview.canResume).toBe(true);
    expect(preview.deadline).toContain("不受 24 小时");
    expect(RESUME_UNDO_NOTICE).toContain("可能已部分");
    expect(RESUME_UNDO_NOTICE).toContain("核对");
  });

  it("blocks resume while an unknown outcome still needs manual review", () => {
    const preview = buildMergeUndoPreview(
      journal({ undoing: true }),
      { now: nowMs, unknownSince: at(-hour) },
    );

    expect(preview.status).toBe("in-progress");
    expect(preview.canResume).toBe(false);
  });

  it("keeps an interrupted undo resumable when the old timestamp is unreadable", () => {
    const preview = buildMergeUndoPreview(
      journal({ undoing: true, at: "not-a-date" }),
      { now: nowMs },
    );

    expect(preview.status).toBe("in-progress");
    expect(preview.timeKnown).toBe(false);
    expect(preview.canResume).toBe(true);
    expect(preview.deadline).toContain("不依赖 24 小时");
  });
});

describe("unknown outcome locks", () => {
  it("keeps the first unknown timestamp for the same journal", () => {
    const first = lockMergeUndoUnknown({}, "merge_1", at(-2 * hour));
    const second = lockMergeUndoUnknown(first, "merge_1", at(-hour));

    expect(second["merge_1"]).toBe(at(-2 * hour));
  });

  it("unlocks only when the user explicitly clears the marker", () => {
    const locks = lockMergeUndoUnknown({}, "merge_1", at(-hour));

    expect(unlockMergeUndoUnknown(locks, "merge_1")).toEqual({});
    expect(locks["merge_1"]).toBe(at(-hour));
  });

  it("keeps the lock when a refresh still does not show the undo as done", () => {
    const locks: MergeUndoLocks = { merge_1: at(-hour) };

    expect(reconcileMergeUndoUnknown(locks, [journal({ undone: false })])).toEqual(locks);
  });

  it("clears the lock only when the server confirms the undo was applied", () => {
    const locks: MergeUndoLocks = { merge_1: at(-hour) };

    expect(reconcileMergeUndoUnknown(locks, [journal({ undone: true })])).toEqual({});
  });

  it("keeps the lock when the journal drops out of the refreshed page", () => {
    const locks: MergeUndoLocks = { merge_1: at(-hour) };

    expect(reconcileMergeUndoUnknown(locks, [])).toEqual(locks);
  });

  it("parses only well-formed lock records and round-trips them", () => {
    expect(parseMergeUndoLocks(null)).toEqual({});
    expect(parseMergeUndoLocks("not json")).toEqual({});
    expect(parseMergeUndoLocks('{"merge_1":5}')).toEqual({});
    const locks: MergeUndoLocks = { merge_1: at(-hour) };
    expect(parseMergeUndoLocks(serializeMergeUndoLocks(locks))).toEqual(locks);
  });

  it("treats only the explicit ApiError code as an unknown outcome", () => {
    expect(
      isUnknownOutcome(new ApiError(504, "操作结果未知", "OPENMEM_OUTCOME_UNKNOWN")),
    ).toBe(true);
    expect(isUnknownOutcome(new ApiError(400, "条目在合并后已被修改"))).toBe(false);
    expect(isUnknownOutcome(new Error("网络断开"))).toBe(false);
    expect(isUnknownOutcome({ code: "OPENMEM_OUTCOME_UNKNOWN" })).toBe(false);
  });
});

class MemoryLockStorage implements MergeUndoLockStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

class BlockedLockStorage implements MergeUndoLockStorage {
  getItem(): string | null {
    throw new Error("storage blocked");
  }

  setItem(): void {
    throw new Error("storage blocked");
  }

  removeItem(): void {
    throw new Error("storage blocked");
  }
}

class ReadOnlyLockStorage implements MergeUndoLockStorage {
  constructor(private readonly data: Record<string, string>) {}

  getItem(key: string): string | null {
    return this.data[key] ?? null;
  }

  setItem(): void {
    throw new Error("storage blocked");
  }

  removeItem(): void {
    throw new Error("storage blocked");
  }
}

describe("unavailable lock storage", () => {
  it("keeps session locks when both reads and writes are blocked", () => {
    const loaded = loadMergeUndoLocks(new BlockedLockStorage());
    const session: MergeUndoLocks = { merge_1: at(-hour) };

    expect(loaded).toEqual({ locks: {}, persistence: "unavailable" });
    expect(resolveMergeUndoLocks(loaded, session)).toEqual(session);
    expect(saveMergeUndoLocks(new BlockedLockStorage(), session)).toBe("unavailable");
    expect(shouldWarnBeforeUnload(1, loaded.persistence)).toBe(true);
  });

  it("detects storage that reads but refuses writes", () => {
    const storage = new ReadOnlyLockStorage({
      [MERGE_UNDO_LOCKS_KEY]: JSON.stringify({ merge_1: at(-hour) }),
    });
    const loaded = loadMergeUndoLocks(storage);

    expect(loaded.locks).toEqual({ merge_1: at(-hour) });
    expect(loaded.persistence).toBe("unavailable");
    expect(shouldWarnBeforeUnload(1, loaded.persistence)).toBe(true);
  });

  it("keeps locks read from read-only storage instead of dropping them", () => {
    const storage = new ReadOnlyLockStorage({
      [MERGE_UNDO_LOCKS_KEY]: JSON.stringify({ merge_1: at(-hour) }),
    });
    const loaded = loadMergeUndoLocks(storage);

    expect(resolveMergeUndoLocks(loaded, {})).toEqual({ merge_1: at(-hour) });
    expect(resolveMergeUndoLocks(loaded, { merge_2: at(-2 * hour) })).toEqual({
      merge_1: at(-hour),
      merge_2: at(-2 * hour),
    });
  });

  it("uses tombstones so a read-only lock does not return after an explicit unlock", () => {
    const storage = new ReadOnlyLockStorage({
      [MERGE_UNDO_LOCKS_KEY]: JSON.stringify({ merge_1: at(-hour) }),
    });
    const loaded = loadMergeUndoLocks(storage);
    const tombstones = new Set(["merge_1"]);

    expect(resolveMergeUndoLocks(loaded, {}, tombstones)).toEqual({});
    expect(
      resolveMergeUndoLocks(loaded, { merge_1: at(-2 * hour) }, tombstones),
    ).toEqual({ merge_1: at(-2 * hour) });
  });

  it("only allows clearing older markers after the journal list loaded", () => {
    expect(canClearUnknownLocks("loading")).toBe(false);
    expect(canClearUnknownLocks("failed")).toBe(false);
    expect(canClearUnknownLocks("ready")).toBe(true);
  });

  it("ignores an older success that lands after a newer failure", () => {
    const gate = createLoadRequestGate();
    const older = startLoadRequest(gate);
    const newer = startLoadRequest(gate);

    expect(canApplyLoadRequest(gate, newer)).toBe(true); // newer request failed
    expect(canApplyLoadRequest(gate, older)).toBe(false); // late success must not turn failed into ready
  });

  it("ignores an older failure that lands after a newer success", () => {
    const gate = createLoadRequestGate();
    const older = startLoadRequest(gate);
    const newer = startLoadRequest(gate);

    expect(canApplyLoadRequest(gate, newer)).toBe(true); // newer request succeeded
    expect(canApplyLoadRequest(gate, older)).toBe(false); // late failure must not replace ready
  });

  it("ignores every in-flight response after unmount", () => {
    const gate = createLoadRequestGate();
    const inFlight = startLoadRequest(gate);

    invalidateLoadRequests(gate);
    expect(canApplyLoadRequest(gate, inFlight)).toBe(false);

    gate.mounted = true; // a later mount starts a fresh generation
    const remounted = startLoadRequest(gate);
    expect(canApplyLoadRequest(gate, remounted)).toBe(true);
    expect(canApplyLoadRequest(gate, inFlight)).toBe(false);
  });

  it("applies a normal latest request", () => {
    const gate = createLoadRequestGate();
    const latest = startLoadRequest(gate);
    expect(canApplyLoadRequest(gate, latest)).toBe(true);
  });

  it("persists and resolves locks when storage works", () => {
    const storage = new MemoryLockStorage();
    const locks: MergeUndoLocks = { merge_1: at(-hour) };

    expect(saveMergeUndoLocks(storage, locks)).toBe("available");
    const loaded = loadMergeUndoLocks(storage);
    expect(loaded).toEqual({ locks, persistence: "available" });
    expect(resolveMergeUndoLocks(loaded, { merge_2: at(-2 * hour) })).toEqual({
      merge_1: at(-hour),
      merge_2: at(-2 * hour),
    });
    expect(shouldWarnBeforeUnload(1, loaded.persistence)).toBe(false);
  });

  it("states plainly that unsaved markers do not survive a full reload", () => {
    expect(SESSION_ONLY_UNKNOWN_NOTICE).toContain("不能跨整页重载");
    expect(SESSION_ONLY_UNKNOWN_NOTICE).toContain("仅在此会话");
    expect(SESSION_ONLY_UNKNOWN_NOTICE).toContain("页面内刷新");
    expect(UNSAVED_UNKNOWN_LEAVE_NOTICE).toContain("离开页面");
  });
});

class FakeLeaveTarget implements MergeUndoLeaveTarget {
  listener?: MergeUndoLeaveListener;
  additions = 0;
  removals = 0;

  addEventListener(type: "beforeunload", listener: MergeUndoLeaveListener): void {
    expect(type).toBe("beforeunload");
    this.listener = listener;
    this.additions += 1;
  }

  removeEventListener(type: "beforeunload", listener: MergeUndoLeaveListener): void {
    expect(type).toBe("beforeunload");
    if (this.listener === listener) this.listener = undefined;
    this.removals += 1;
  }

  dispatch(): { prevented: boolean; returnValue: unknown } {
    let prevented = false;
    const event: MergeUndoLeaveEvent = {
      preventDefault: () => {
        prevented = true;
      },
    };
    this.listener?.(event);
    return { prevented, returnValue: event.returnValue };
  }
}

describe("leave warning manager", () => {
  it("keeps warning after Health unmounts while markers are session-only", () => {
    syncMergeUndoLeaveWarning(undefined, 0, "unavailable");
    const target = new FakeLeaveTarget();

    syncMergeUndoLeaveWarning(target, 1, "unavailable");
    expect(target.additions).toBe(1);

    // No cleanup call simulates Health being unmounted by a tab switch.
    const event = target.dispatch();
    expect(event.prevented).toBe(true);
    expect(String(event.returnValue)).toContain("离开页面");

    syncMergeUndoLeaveWarning(target, 1, "unavailable");
    expect(target.additions).toBe(1);
    expect(target.removals).toBe(0);
  });

  it("removes the warning once markers are gone or persistence succeeds", () => {
    syncMergeUndoLeaveWarning(undefined, 0, "unavailable");
    const target = new FakeLeaveTarget();

    syncMergeUndoLeaveWarning(target, 1, "unavailable");
    syncMergeUndoLeaveWarning(target, 0, "unavailable");
    expect(target.listener).toBeUndefined();
    expect(target.removals).toBe(1);

    syncMergeUndoLeaveWarning(target, 1, "unavailable");
    syncMergeUndoLeaveWarning(target, 1, "available");
    expect(target.listener).toBeUndefined();
    expect(target.removals).toBe(2);
  });
});
