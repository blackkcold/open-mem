import { describe, expect, it } from "vitest";
import {
  activitySummary,
  activityTypeOf,
  compareActivity,
  eventFromChange,
  eventFromChangelog,
  eventFromHook,
  eventFromReview,
  reasonCategory,
  startOfDay,
} from "../../console/src/pages/activity-model.js";
import type { ActivityEvent, ReasonCategory } from "../../console/src/pages/activity-model.js";
import type {
  ChangelogEntry,
  ChangeEvent,
  HookRecord,
  MemoryItem,
  ReviewRecord,
} from "../../console/src/types.js";

const item = (overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id: "item-1",
  title: "回复先给结论",
  text: "这个项目回复先给结论",
  kind: "preference",
  scope: "project",
  status: "auto",
  source: { sessionID: "session-1" },
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
  at: "2026-11-18T09:00:00.000Z",
  kind: "update",
  actor: "auto",
  itemID: "item-1",
  source: {},
  reason: "更新内容",
  revertible: false,
  ...overrides,
});

const entry = (overrides: Partial<ChangelogEntry> = {}): ChangelogEntry => ({
  at: "2026-11-18T09:00:00.000Z",
  action: "capture_blocked",
  ...overrides,
});

const review = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  id: "review_1",
  sessionID: "session-1234567890",
  status: "ready",
  createdAt: "2026-11-18T09:00:00.000Z",
  candidates: 3,
  dropped: 0,
  ...overrides,
});

const hook = (overrides: Partial<HookRecord> = {}): HookRecord => ({
  id: "hook_1",
  key: "turn|session-1|message-1",
  sessionID: "session-1",
  turnID: "turn-1",
  messageID: "message-1",
  text: "回复先给结论",
  title: "候选标题",
  trigger: "turn",
  scope: "global",
  source: { sessionID: "session-1" },
  createdAt: "2026-11-18T09:00:00.000Z",
  updatedAt: "2026-11-18T09:00:00.000Z",
  status: "failed",
  attempts: 1,
  ...overrides,
});

const event = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "event-1",
  at: "2026-11-18T09:00:00.000Z",
  type: "write",
  title: "回复先给结论",
  reason: "",
  result: "success",
  revertible: false,
  sourceLabel: "自动",
  ...overrides,
});

describe("reasonCategory", () => {
  it("recognises the documented causes", () => {
    const cases: Array<[string, ReasonCategory]> = [
      ["请求超时", "timeout"],
      ["connect ETIMEDOUT", "timeout"],
      ["429 Too Many Requests", "rate-limit"],
      ["触发限流", "rate-limit"],
      ["重复候选", "duplicate"],
      ["capacity full", "capacity"],
      ["容量已满", "capacity"],
      ["包含敏感信息", "sensitive"],
      ["credential leaked", "sensitive"],
      ["schema invalid", "validation"],
      ["校验不合格", "validation"],
    ];
    for (const [text, expected] of cases) {
      expect(reasonCategory(text), text).toBe(expected);
    }
  });

  it("returns 其他 for empty or unrecognised reasons", () => {
    expect(reasonCategory("")).toBe("unknown");
    expect(reasonCategory("没有可识别的原因")).toBe("unknown");
  });

  it("prefers the first matching cause when several appear", () => {
    expect(reasonCategory("请求超时，容量已满")).toBe("timeout");
    expect(reasonCategory("429 限流，重复候选")).toBe("rate-limit");
  });
});

describe("activityTypeOf", () => {
  it("counts only automatic writes as 自动写入", () => {
    for (const kind of ["add", "update", "merge", "replace", "promote"] as const) {
      expect(activityTypeOf(kind), kind).toBe("write");
    }
    expect(activityTypeOf("update", "curator")).toBe("write");
    expect(activityTypeOf("update", "system")).toBe("write");
    expect(activityTypeOf("update", "user")).toBe("maintenance");
    expect(activityTypeOf("update", "auto", "user")).toBe("maintenance");
  });

  it("maps migration provenance separately from user maintenance", () => {
    expect(activityTypeOf("add", "migration")).toBe("migration");
    expect(activityTypeOf("migration", "auto", "migration")).toBe("migration");
  });

  it("maps undo and lifecycle kinds to their own types", () => {
    expect(activityTypeOf("revert")).toBe("revert");
    expect(activityTypeOf("revert", "user")).toBe("revert");
    expect(activityTypeOf("restore")).toBe("restore");
    expect(activityTypeOf("deactivate", "user")).toBe("stop");
    expect(activityTypeOf("expire", "curator")).toBe("maintenance");
    expect(activityTypeOf("archive", "user")).toBe("maintenance");
    expect(activityTypeOf("invalidate")).toBe("maintenance");
  });
});

describe("eventFromChange", () => {
  const items = new Map([["item-1", item()]]);
  const versions = new Map([["item-1", "v9"]]);

  it("builds a write event from the change and binds the current version", () => {
    const result = eventFromChange(
      change({ id: "change_9", after: item({ title: "新标题" }) }),
      items,
      versions,
    );
    expect(result.id).toBe("change_9");
    expect(result.changeID).toBe("change_9");
    expect(result.type).toBe("write");
    expect(result.title).toBe("新标题");
    expect(result.itemID).toBe("item-1");
    expect(result.reason).toBe("更新内容");
    expect(result.reasonCategory).toBeUndefined();
    expect(result.result).toBe("success");
    expect(result.revertible).toBe(false);
    expect(result.expectedVersion).toBe("v9");
    expect(result.sourceLabel).toBe("自动");
    expect(result.subtype).toBeUndefined();
  });

  it("falls back to the change label when no reason was recorded", () => {
    const result = eventFromChange(change({ kind: "merge", reason: "" }), items, versions);
    expect(result.reason).toBe("合并");
  });

  it("names the object from snapshots, then the item map, then a short id", () => {
    const beforeOnly = eventFromChange(
      change({ after: undefined, before: item({ title: "旧标题" }) }),
      new Map(),
      new Map(),
    );
    expect(beforeOnly.title).toBe("旧标题");

    const fromMap = eventFromChange(change({ after: undefined }), items, versions);
    expect(fromMap.title).toBe("回复先给结论");

    const missing = eventFromChange(
      change({ itemID: "missing-item", after: undefined }),
      new Map(),
      new Map(),
    );
    expect(missing.title).toBe("条目 missing-item");
    expect(missing.expectedVersion).toBeUndefined();
  });

  it("marks a deactivate as a stop with an unknown cause", () => {
    const result = eventFromChange(change({ kind: "deactivate", actor: "user" }), items, versions);
    expect(result.type).toBe("stop");
    expect(result.reasonCategory).toBe("unknown");
    expect(result.sourceLabel).toBe("你");
  });

  it("labels every actor truthfully", () => {
    const labels: Array<[ChangeEvent["actor"], string]> = [
      ["auto", "自动"],
      ["user", "你"],
      ["curator", "维护"],
      ["migration", "迁移"],
      ["system", "系统"],
    ];
    for (const [actor, expected] of labels) {
      expect(eventFromChange(change({ actor }), items, versions).sourceLabel, actor).toBe(
        expected,
      );
    }
  });

  it("marks manual maintenance and passes revertibility through", () => {
    const result = eventFromChange(
      change({ kind: "archive", actor: "user", revertible: true }),
      items,
      versions,
    );
    expect(result.type).toBe("maintenance");
    expect(result.subtype).toBe("手动写入");
    expect(result.revertible).toBe(true);
  });

  it("reports a revert as its own event and never offers to undo it again", () => {
    const result = eventFromChange(
      change({
        id: "change_10",
        kind: "revert",
        actor: "user",
        reason: "",
        reverts: "change_9",
        revertible: false,
      }),
      items,
      versions,
    );
    expect(result.type).toBe("revert");
    expect(result.reason).toBe("撤销");
    expect(result.revertible).toBe(false);
    expect(result.sourceLabel).toBe("你");
  });
});

describe("eventFromChangelog", () => {
  it("ignores actions outside the activity taxonomy", () => {
    expect(eventFromChangelog(entry({ action: "accept" }))).toBeNull();
    expect(eventFromChangelog(entry({ action: "enqueue" }))).toBeNull();
  });

  it("reports a blocked capture as a skip with an unknown result", () => {
    const result = eventFromChangelog(
      entry({ action: "capture_blocked", reason: "请求超时", itemID: "item-1" }),
    );
    expect(result).not.toBeNull();
    expect(result?.id).toBe("changelog:2026-11-18T09:00:00.000Z:capture_blocked:item-1");
    expect(result?.type).toBe("skip");
    expect(result?.result).toBe("unknown");
    expect(result?.reasonCategory).toBe("timeout");
    expect(result?.revertible).toBe(false);
    expect(result?.subtype).toBe("capture_blocked");
    expect(result?.title).toBe("条目 item-1");
    expect(result?.sourceLabel).toBe("服务端");
  });

  it("derives capacity and source-change categories from the action", () => {
    expect(
      eventFromChangelog(entry({ action: "extract_quarantine_capacity", reason: "已满" }))
        ?.reasonCategory,
    ).toBe("capacity");
    expect(
      eventFromChangelog(entry({ action: "extract_source_changed" }))?.reasonCategory,
    ).toBe("validation");
  });

  it("reports maintenance without turning it into a skip", () => {
    const result = eventFromChangelog(
      entry({ action: "retention_auto", reason: "", count: 3, source: "维护任务" }),
    );
    expect(result?.type).toBe("maintenance");
    expect(result?.result).toBe("unknown");
    expect(result?.reasonCategory).toBeUndefined();
    expect(result?.reason).toBe("自动回收派生历史（3）");
    expect(result?.sourceLabel).toBe("维护任务");
    expect(result?.subtype).toBe("retention_auto");
  });

  it("prefers a recorded reason over the built-in description", () => {
    const result = eventFromChangelog(
      entry({
        action: "capture_blocked",
        reason: "模型超时",
        decision: "ignored",
        reasons: ["重复候选"],
      }),
    );
    expect(result?.reason).toBe("模型超时");
    expect(result?.reasonCategory).toBe("timeout");

    const fromDecision = eventFromChangelog(
      entry({ action: "capture_rejected", decision: "候选未通过准入" }),
    );
    expect(fromDecision?.reason).toBe("候选未通过准入");
  });

  it("reports expired candidates as skips with the recorded description", () => {
    const descriptions: Record<string, string> = {
      global_candidate_expired: "全局候选已过期",
      extract_quarantine_expired: "隔离候选已过期",
    };
    for (const [action, description] of Object.entries(descriptions)) {
      const result = eventFromChangelog(entry({ action, reason: "" }));
      expect(result?.type, action).toBe("skip");
      expect(result?.result, action).toBe("unknown");
      expect(result?.reasonCategory, action).toBe("unknown");
      expect(result?.reason, action).toBe(description);
    }
  });

  it("names the object from the item, the session or the system", () => {
    expect(
      eventFromChangelog(entry({ itemID: undefined, sessionID: "session-1234567890" }))?.title,
    ).toBe("会话 session-…890");
    expect(eventFromChangelog(entry())?.title).toBe("系统维护");
  });
});

describe("eventFromReview", () => {
  it("summarises a completed review with its counts", () => {
    const result = eventFromReview(
      review({
        queued: 2,
        learned: 1,
        updated: 1,
        shadowed: 0,
        learningSkipped: 1,
        learningDeferred: "预算不足",
        model: "synthetic/rewrite",
      }),
    );
    expect(result.id).toBe("review:review_1");
    expect(result.type).toBe("review");
    expect(result.result).toBe("success");
    expect(result.reasonCategory).toBeUndefined();
    expect(result.reason).toContain("候选 3");
    expect(result.reason).toContain("入队 2");
    expect(result.reason).toContain("学习 1");
    expect(result.reason).toContain("观察 0");
    expect(result.reason).toContain("学习跳过 1");
    expect(result.reason).toContain("延后：预算不足");
    expect(result.title).toBe("会话 session-…890");
    expect(result.sourceLabel).toBe("synthetic/rewrite");
    expect(result.subtype).toBe("复盘");
  });

  it("reports a failed review with its error and category", () => {
    const result = eventFromReview(review({ status: "failed", error: "请求超时" }));
    expect(result.type).toBe("failure");
    expect(result.result).toBe("failure");
    expect(result.reason).toBe("请求超时");
    expect(result.reasonCategory).toBe("timeout");
  });

  it("does not pretend to know why a failed review failed", () => {
    const result = eventFromReview(review({ status: "failed" }));
    expect(result.type).toBe("failure");
    expect(result.result).toBe("failure");
    expect(result.reason).toBe("复盘失败，原因未记录");
    expect(result.reasonCategory).toBe("unknown");
  });

  it("reports a skipped review as a skip, not a failure", () => {
    const result = eventFromReview(review({ status: "skipped" }));
    expect(result.type).toBe("skip");
    expect(result.result).toBe("success");
    expect(result.reason).toBe("本轮没有可复盘内容");

    const noted = eventFromReview(review({ status: "skipped", note: "没有新的用户消息" }));
    expect(noted.reason).toBe("没有新的用户消息");
  });
});

describe("eventFromHook", () => {
  it("ignores hooks that were written or are still pending", () => {
    expect(eventFromHook(hook({ status: "auto" }))).toBeNull();
    expect(eventFromHook(hook({ status: "queue" }))).toBeNull();
    expect(eventFromHook(hook({ status: "shadow" }))).toBeNull();
    expect(eventFromHook(hook({ status: "pending" }))).toBeNull();
  });

  it("reports a failed hook with the recorded error", () => {
    const result = eventFromHook(hook({ status: "failed", error: "429 Too Many Requests" }));
    expect(result?.id).toBe("hook:hook_1");
    expect(result?.type).toBe("failure");
    expect(result?.result).toBe("failure");
    expect(result?.reason).toBe("429 Too Many Requests");
    expect(result?.reasonCategory).toBe("rate-limit");
    expect(result?.sourceLabel).toBe("采集");
    expect(result?.subtype).toBe("自动写入");
    expect(result?.title).toBe("候选标题");
  });

  it("reports an ignored hook from its decision reasons", () => {
    const result = eventFromHook(
      hook({
        status: "ignored",
        decision: {
          kind: "heuristic",
          duplicate: 0,
          safeAuto: 0,
          risk: 0,
          confidence: 0,
          strictness: "default",
          reasons: ["重复候选", "相似度过高"],
          source: "heuristic",
        },
      }),
    );
    expect(result?.type).toBe("skip");
    expect(result?.result).toBe("success");
    expect(result?.reason).toBe("重复候选、相似度过高");
    expect(result?.reasonCategory).toBe("duplicate");
    expect(result?.subtype).toBe("自动跳过");
  });

  it("reports a blocked hook as a skip and explains a silent one", () => {
    const blocked = eventFromHook(
      hook({
        status: "blocked",
        decision: {
          kind: "heuristic",
          duplicate: 0,
          safeAuto: 0,
          risk: 0,
          confidence: 0,
          strictness: "default",
          reasons: ["容量已满"],
          source: "heuristic",
        },
      }),
    );
    expect(blocked?.type).toBe("skip");
    expect(blocked?.reasonCategory).toBe("capacity");

    const silent = eventFromHook(hook({ status: "ignored", title: "" }));
    expect(silent?.reason).toBe("未达到写入条件");
    expect(silent?.title).toBe("候选 hook_1");
    expect(silent?.reasonCategory).toBe("unknown");
  });
});

describe("activitySummary", () => {
  const now = Date.parse("2026-11-18T12:00:00");
  const at = (offsetMs: number): string => new Date(now - offsetMs).toISOString();

  it("counts only today's write, skip, failure and revert events", () => {
    const summary = activitySummary(
      [
        event({ id: "w1", at: at(60_000) }),
        event({ id: "w2", at: at(60_000) }),
        event({ id: "s1", type: "skip", at: at(2 * 60_000) }),
        event({ id: "f1", type: "failure", at: at(3 * 60_000) }),
        event({ id: "r1", type: "revert", at: at(4 * 60_000) }),
        event({ id: "m1", type: "maintenance", at: at(5 * 60_000) }),
        event({ id: "o1", type: "stop", at: at(6 * 60_000) }),
        event({ id: "old", at: at(2 * 24 * 60 * 60 * 1000) }),
        event({ id: "bad", at: "not-a-date" }),
      ],
      now,
    );
    expect(summary.today).toEqual({ write: 2, skip: 1, failure: 1, revert: 1 });
    expect(summary.partial).toBe(false);
  });

  it("includes an event at the start of the local day and excludes earlier ones", () => {
    const start = startOfDay(now);
    const summary = activitySummary(
      [
        event({ id: "boundary", at: new Date(start).toISOString() }),
        event({ id: "earlier", at: new Date(start - 1).toISOString() }),
      ],
      now,
    );
    expect(summary.today.write).toBe(1);
  });

  it("returns zero counts for an empty ledger", () => {
    expect(activitySummary([], now)).toEqual({
      today: { write: 0, skip: 0, failure: 0, revert: 0 },
      partial: false,
    });
  });
});

describe("compareActivity", () => {
  it("sorts newest first and breaks ties by id, descending", () => {
    const rows = [
      event({ id: "event:old", at: "2026-11-17T09:00:00.000Z" }),
      event({ id: "event:a", at: "2026-11-18T09:00:00.000Z" }),
      event({ id: "event:b", at: "2026-11-18T09:00:00.000Z" }),
    ].sort(compareActivity);
    expect(rows.map((row) => row.id)).toEqual(["event:b", "event:a", "event:old"]);
  });

  it("treats equal timestamps and ids as equal", () => {
    expect(compareActivity(event(), event())).toBe(0);
  });
});
