import { describe, expect, it } from "vitest";
import {
  anyQueueFilterActive,
  describeDuplicateClues,
  emptyQueueFilters,
  queueScopeView,
  reviewCountsView,
  summarizeTurnHooks,
} from "../../console/src/pages/queue-triage";

function hook(status: string): { status: string } {
  return { status };
}

describe("turn hook status breakdown", () => {
  it("counts every real hook status and keeps blocked apart from ignored", () => {
    const view = summarizeTurnHooks({
      counts: { captured: 15 },
      hooks: [
        hook("blocked"),
        hook("blocked"),
        hook("pending"),
        hook("processing"),
        hook("queue"),
        hook("queue"),
        hook("queue"),
        hook("ignored"),
        hook("ignored"),
        hook("ignored"),
        hook("ignored"),
        hook("failed"),
        hook("auto"),
        hook("auto"),
        hook("shadow"),
      ],
    });
    expect(view.hasHooks).toBe(true);
    expect(view.captured).toBe(15);
    const counts = Object.fromEntries(
      view.entries.map((entry) => [entry.status, entry.count]),
    );
    expect(counts.blocked).toBe(2);
    expect(counts.ignored).toBe(4);
    expect(counts.pending).toBe(1);
    expect(counts.processing).toBe(1);
    expect(counts.queue).toBe(3);
    expect(counts.failed).toBe(1);
    expect(counts.auto).toBe(2);
    expect(counts.shadow).toBe(1);
    expect(counts.blocked).not.toBe(counts.ignored);
  });

  it("treats an empty hook list as a real zero, not as unknown", () => {
    const view = summarizeTurnHooks({ counts: { captured: 0 }, hooks: [] });
    expect(view.hasHooks).toBe(true);
    expect(view.captured).toBe(0);
    expect(view.entries.every((entry) => entry.count === 0)).toBe(true);
    expect(view.note).toBe("");
  });

  it("reports unknown statuses instead of inventing zeroes for old data", () => {
    const view = summarizeTurnHooks({
      counts: { captured: 5, queue: 2, ignored: 3 },
    });
    expect(view.hasHooks).toBe(false);
    expect(view.captured).toBe(5);
    expect(view.entries.every((entry) => entry.count === null)).toBe(true);
    expect(view.note).toContain("未知");
    expect(view.note).toContain("blocked");
  });

  it("does not fake captured when both hooks and counts are missing", () => {
    const view = summarizeTurnHooks(undefined);
    expect(view.captured).toBeNull();
    expect(view.hasHooks).toBe(false);
    expect(view.entries.every((entry) => entry.count === null)).toBe(true);
  });

  it("falls back to the hook list for the captured total", () => {
    const view = summarizeTurnHooks({ hooks: [hook("queue"), hook("blocked")] });
    expect(view.captured).toBe(2);
  });

  it("counts unrecognized statuses separately and says so", () => {
    const view = summarizeTurnHooks({
      counts: { captured: 2 },
      hooks: [hook("queue"), hook("mystery")],
    });
    expect(view.unrecognized).toBe(1);
    expect(view.note).toContain("未识别");
    expect(view.entries.find((entry) => entry.status === "queue")?.count).toBe(1);
  });
});

describe("review count wording", () => {
  it("labels queued as generated candidates, never as admitted queue items", () => {
    const view = reviewCountsView({ queued: 7, candidates: 9, dropped: 2 });
    expect(view.hooksCreated).toBe(7);
    expect(view.queuedKnown).toBe(true);
    expect(view.skipped).toBe(0);
    const labels = view.segments.map((segment) => segment.label);
    expect(labels).toContain("生成候选");
    expect(labels).not.toContain("入队");
    expect(view.note).toContain("未必进入审批队列");
  });

  it("shows unknown instead of a fake zero when queued is absent", () => {
    const view = reviewCountsView({ candidates: 9, dropped: 2 });
    expect(view.hooksCreated).toBeNull();
    expect(view.queuedKnown).toBe(false);
    const segment = view.segments.find((entry) => entry.label === "生成候选");
    expect(segment?.value).toBeNull();
  });

  it("rejects negative or non-integer counts instead of displaying them", () => {
    expect(reviewCountsView({ queued: -1, candidates: 4, dropped: 0 }).hooksCreated).toBeNull();
    expect(reviewCountsView({ queued: 1.5, candidates: 4, dropped: 0 }).hooksCreated).toBeNull();
    expect(reviewCountsView({ queued: 2, candidates: -3, dropped: 0 }).candidates).toBeNull();
  });

  it("never computes a negative skipped count", () => {
    expect(reviewCountsView({ queued: 5, candidates: 3, dropped: 0 }).skipped).toBeNull();
    expect(reviewCountsView({ queued: 2, candidates: 3, dropped: 5 }).skipped).toBeNull();
    for (const segment of reviewCountsView({ queued: 2, candidates: 3, dropped: 5 }).segments) {
      if (segment.value !== null) expect(segment.value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("structured duplicate and merge clues", () => {
  it("shows a stored decision score and merge target as system judgement", () => {
    const view = describeDuplicateClues({
      decision: {
        kind: "fact",
        duplicate: 0.92,
        mergeAction: "merge_into",
        mergeTargetId: "mem_1",
      },
    });
    expect(view.available).toBe(true);
    expect(view.source).toBe("decision");
    expect(view.duplicateScore).toBe(0.92);
    expect(view.mergeAction).toBe("merge_into");
    expect(view.mergeTargetId).toBe("mem_1");
    expect(view.label).toBe("系统判断");
    expect(view.clues.some((clue) => clue.text.includes("92%"))).toBe(true);
    expect(view.clues.some((clue) => clue.text.includes("mem_1"))).toBe(true);
    expect(view.clues.map((clue) => clue.text).join(" ")).not.toContain("确认重复");
  });

  it("falls back to the legacy jev field and labels the source", () => {
    const view = describeDuplicateClues({
      jev: { kind: "fact", duplicate: 0.81, mergeAction: "replace", mergeTargetId: "mem_old" },
    });
    expect(view.available).toBe(true);
    expect(view.source).toBe("jev");
    expect(view.duplicateScore).toBe(0.81);
    expect(view.mergeTargetId).toBe("mem_old");
  });

  it("shows a suggestion action, target and concentration as stored clues", () => {
    const view = describeDuplicateClues({
      suggestion: {
        action: "merge_into",
        targetId: "mem_2",
        targetTitle: "旧条目",
        confidence: 0.88,
      },
    });
    expect(view.available).toBe(true);
    expect(view.source).toBe("suggestion");
    expect(view.suggestionAction).toBe("merge_into");
    expect(view.suggestionTargetId).toBe("mem_2");
    expect(view.suggestionTargetTitle).toBe("旧条目");
    expect(view.suggestionConfidence).toBe(0.88);
  });

  it("marks missing target titles as old or incomplete data instead of guessing", () => {
    const view = describeDuplicateClues({
      decision: { duplicate: 0.5, mergeTargetId: "mem_3" },
    });
    const text = view.clues.map((clue) => clue.text).join(" ");
    expect(text).toContain("mem_3");
    expect(text).toContain("未记录目标标题");
    expect(text).toContain("旧");
  });

  it("says 未标注 when no structured clue exists, even with a similar title", () => {
    const view = describeDuplicateClues({
      title: "完全相同的标题",
      text: "完全相同的文本",
      decision: { kind: "fact", duplicate: 0 },
      suggestion: undefined,
    });
    expect(view.available).toBe(false);
    expect(view.emptyText).toBe("未标注");
    expect(view.clues).toEqual([]);
    expect(view.duplicateScore).toBeNull();
  });

  it("ignores invalid duplicate scores instead of presenting them", () => {
    for (const duplicate of [Number.NaN, -1, 2, "0.9", undefined]) {
      const view = describeDuplicateClues({ decision: { duplicate } });
      expect(view.duplicateScore).toBeNull();
      expect(view.clues.some((clue) => clue.text.includes("重复评分"))).toBe(false);
    }
  });
});

describe("queue scope display", () => {
  it("keeps the filtered count and the global queue count distinct", () => {
    const view = queueScopeView(3, 20, true);
    expect(view.visible).toBe(3);
    expect(view.visibleLabel).toBe("当前筛选");
    expect(view.global).toBe(20);
    expect(view.globalKnown).toBe(true);
    expect(view.globalLabel).toBe("全部待审");
  });

  it("never uses the filtered count as the global total", () => {
    const view = queueScopeView(3, undefined, true);
    expect(view.global).toBeNull();
    expect(view.globalKnown).toBe(false);
  });

  it("rejects invalid metrics instead of showing them as totals", () => {
    expect(queueScopeView(3, -1, true).global).toBeNull();
    expect(queueScopeView(3, 2.5, true).global).toBeNull();
    expect(queueScopeView(3, Number.NaN, true).global).toBeNull();
  });

  it("labels the unfiltered view as the current list", () => {
    expect(queueScopeView(3, 3, false).visibleLabel).toBe("当前列表");
  });
});

describe("clearing queue filters", () => {
  it("clears every filter including the project", () => {
    const empty = emptyQueueFilters();
    expect(empty).toEqual({
      kind: "",
      scope: "",
      projectKey: "",
      originFilter: "",
      query: "",
      queryInput: "",
    });
  });

  it("keeps hasFilters honest for a project-only filter", () => {
    expect(anyQueueFilterActive(emptyQueueFilters())).toBe(false);
    expect(
      anyQueueFilterActive({ ...emptyQueueFilters(), projectKey: "proj-a" }),
    ).toBe(true);
  });

  it("reports each single filter as active", () => {
    const base = emptyQueueFilters();
    expect(anyQueueFilterActive({ ...base, kind: "rule" })).toBe(true);
    expect(anyQueueFilterActive({ ...base, scope: "project" })).toBe(true);
    expect(anyQueueFilterActive({ ...base, originFilter: "turn" })).toBe(true);
    expect(anyQueueFilterActive({ ...base, query: "x" })).toBe(true);
  });
});
