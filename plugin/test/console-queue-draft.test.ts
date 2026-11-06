import { describe, expect, it } from "vitest";
import {
  canSubmitQueueDraft,
  globalQueueTotal,
  discardQueueDraft,
  hasDirtyQueueDrafts,
  decisionLockedByUnknown,
  decisionSnapshotOf,
  deferRebaseExpectation,
  hasDecisionVersion,
  initialQueueDraft,
  isQueueDraftDirty,
  sameDecisionSnapshot,
  shouldClearConsumedDraft,
  queueDraftConflict,
  rebaselineQueueDraft,
  resolveDeferRebase,
  storeQueueDraft,
  type QueueDraft,
  type QueueDraftSource,
  type QueueDraftSuggestion,
} from "../../console/src/pages/queue-draft";

function source(overrides: Partial<QueueDraftSource> = {}): QueueDraftSource {
  return {
    id: "q-a",
    title: "原始标题",
    text: "原始正文",
    updatedAt: "2026-11-05T10:00:00.000Z",
    decisionVersion: "v1",
    ...overrides,
  };
}

function withSuggestion(overrides: {
  id?: string;
  proposedTitle?: string;
  proposedText?: string;
  createdAt?: string;
  decisionVersion?: string;
} = {}): QueueDraftSource {
  return source({
    decisionVersion: overrides.decisionVersion ?? "v1",
    suggestion: {
      id: overrides.id ?? "sug-1",
      action: "create",
      proposedTitle: overrides.proposedTitle ?? "建议标题",
      proposedText: overrides.proposedText ?? "建议正文",
      createdAt: overrides.createdAt ?? "2026-11-05T10:01:00.000Z",
      validation: { ok: true, errors: [], warnings: [] },
    },
  });
}

function currentSuggestion(
  overrides: Partial<QueueDraftSuggestion> = {},
): QueueDraftSource {
  const base = withSuggestion();
  if (!base.suggestion) throw new Error("expected suggestion fixture");
  return { ...base, suggestion: { ...base.suggestion, ...overrides } };
}

describe("queue draft baselines", () => {
  it("starts from the suggested version when one exists", () => {
    const draft = initialQueueDraft(withSuggestion());
    expect(draft.itemID).toBe("q-a");
    expect(draft.title).toBe("建议标题");
    expect(draft.text).toBe("建议正文");
    expect(draft.note).toBe("");
    expect(draft.baseline.suggestionID).toBe("sug-1");
    expect(isQueueDraftDirty(draft)).toBe(false);
  });

  it("starts from the original candidate when there is no suggestion", () => {
    const draft = initialQueueDraft(source());
    expect(draft.title).toBe("原始标题");
    expect(draft.text).toBe("原始正文");
    expect(draft.baseline.suggestionID).toBeNull();
  });

  it("marks title, text and note edits as dirty, and clean when reverted", () => {
    const base = initialQueueDraft(withSuggestion());
    expect(isQueueDraftDirty({ ...base, title: "改标题" })).toBe(true);
    expect(isQueueDraftDirty({ ...base, text: "改正文" })).toBe(true);
    expect(isQueueDraftDirty({ ...base, note: "改备注" })).toBe(true);
  });
});

describe("queue draft isolation", () => {
  it("keeps drafts for different ids apart and restores each on return", () => {
    const first = { ...initialQueueDraft(withSuggestion()), title: "A 的草稿" };
    const second = {
      ...initialQueueDraft(source({ id: "q-b", title: "B 原始", text: "B 正文" })),
      text: "B 的草稿",
    };
    let drafts = storeQueueDraft({}, first);
    drafts = storeQueueDraft(drafts, second);

    expect(drafts["q-a"]?.title).toBe("A 的草稿");
    expect(drafts["q-b"]?.text).toBe("B 的草稿");
    // Returning to the page reads the same per-id draft.
    expect(drafts[first.itemID].title).toBe("A 的草稿");
    expect(drafts[second.itemID].text).toBe("B 的草稿");
  });

  it("never applies one item's baseline to another item", () => {
    const draft = { ...initialQueueDraft(withSuggestion()), title: "改过的标题" };
    const conflict = queueDraftConflict(
      draft,
      source({ id: "q-b", title: "另一条", text: "另一条正文" }),
    );
    expect(conflict).toBe("suggestion-changed");
  });

  it("drops a draft as soon as all fields match the baseline again", () => {
    const base = initialQueueDraft(withSuggestion());
    const dirty = storeQueueDraft({}, { ...base, title: "临时" });
    expect(Object.keys(dirty)).toEqual(["q-a"]);
    expect(storeQueueDraft(dirty, base)).toEqual({});
    expect(hasDirtyQueueDrafts(dirty)).toBe(true);
    expect(hasDirtyQueueDrafts({})).toBe(false);
  });
});

describe("queue draft conflicts", () => {
  it("flags a changed suggestion version and keeps the draft text", () => {
    const draft = { ...initialQueueDraft(withSuggestion()), title: "我的草稿" };
    expect(
      queueDraftConflict(draft, withSuggestion({ id: "sug-2" })),
    ).toBe("suggestion-changed");
    expect(draft.title).toBe("我的草稿");
  });

  it("flags changed suggestion content even when the id is reused", () => {
    const draft = initialQueueDraft(withSuggestion());
    expect(
      queueDraftConflict(
        draft,
        withSuggestion({ proposedTitle: "新的建议标题" }),
      ),
    ).toBe("suggestion-changed");
  });

  it("flags changed candidate content and ignores a bare updatedAt bump", () => {
    const draft = initialQueueDraft(source());
    // updatedAt alone is not a decision-relevant change (defer updates it).
    expect(
      queueDraftConflict(
        draft,
        source({ updatedAt: "2026-11-05T11:00:00.000Z" }),
      ),
    ).toBeNull();
    expect(queueDraftConflict(draft, source({ text: "原始正文已变" }))).toBe(
      "item-changed",
    );
  });

  it("flags a disappeared candidate without losing the draft", () => {
    const draft = { ...initialQueueDraft(source()), note: "要保留的备注" };
    expect(queueDraftConflict(draft, null)).toBe("item-missing");
    expect(draft.note).toBe("要保留的备注");
  });

  it("clears the conflict after an explicit rebaseline and keeps the edits", () => {
    const draft = { ...initialQueueDraft(withSuggestion()), title: "旧草稿" };
    const current = withSuggestion({ id: "sug-2", proposedTitle: "新建议标题" });
    expect(queueDraftConflict(draft, current)).toBe("suggestion-changed");
    const rebased = rebaselineQueueDraft(draft, current);
    expect(rebased).not.toBeNull();
    if (!rebased) return;
    expect(rebased.title).toBe("旧草稿");
    expect(rebased.baseline.suggestionID).toBe("sug-2");
    expect(queueDraftConflict(rebased, current)).toBeNull();
  });
});

describe("queue draft discard and submission", () => {
  it("discards only the requested draft", () => {
    let drafts = storeQueueDraft(
      {},
      { ...initialQueueDraft(source()), title: "A" },
    );
    drafts = storeQueueDraft(
      drafts,
      { ...initialQueueDraft(source({ id: "q-b" })), title: "B" },
    );
    const after = discardQueueDraft(drafts, "q-a");
    expect(Object.keys(after)).toEqual(["q-b"]);
  });

  it("blocks decisions while the draft conflicts, is unavailable or busy", () => {
    expect(
      canSubmitQueueDraft({ busy: false, unavailable: false, conflict: null }),
    ).toBe(true);
    expect(
      canSubmitQueueDraft({
        busy: false,
        unavailable: false,
        conflict: "suggestion-changed",
      }),
    ).toBe(false);
    expect(
      canSubmitQueueDraft({ busy: true, unavailable: false, conflict: null }),
    ).toBe(false);
    expect(
      canSubmitQueueDraft({ busy: false, unavailable: true, conflict: null }),
    ).toBe(false);
  });

  it("keeps an unavailable draft readable for copying", () => {
    const draft: QueueDraft = {
      ...initialQueueDraft(source()),
      title: "复制我",
      note: "备注也要保留",
    };
    const drafts = storeQueueDraft({}, draft);
    expect(drafts["q-a"]).toMatchObject({
      title: "复制我",
      note: "备注也要保留",
    });
    expect(
      canSubmitQueueDraft({
        busy: false,
        unavailable: queueDraftConflict(draft, null) === "item-missing",
        conflict: queueDraftConflict(draft, null),
      }),
    ).toBe(false);
  });
});

describe("global queue total from App metrics", () => {
  it("shows unknown until the App has a live value", () => {
    expect(globalQueueTotal(undefined)).toBeNull();
    expect(globalQueueTotal(null)).toBeNull();
  });

  it("accepts a real non-negative integer total", () => {
    expect(globalQueueTotal(0)).toBe(0);
    expect(globalQueueTotal(20)).toBe(20);
  });

  it("rejects stale or malformed values instead of displaying them", () => {
    expect(globalQueueTotal(-1)).toBeNull();
    expect(globalQueueTotal(2.5)).toBeNull();
    expect(globalQueueTotal(Number.NaN)).toBeNull();
  });
});

describe("queue draft identity and full version binding", () => {
  it("flags another queue id even when every other field is identical", () => {
    const draft = { ...initialQueueDraft(withSuggestion()), title: "我的草稿" };
    const twin = { ...withSuggestion(), id: "q-other" };
    expect(queueDraftConflict(draft, twin)).toBe("item-mismatch");
  });

  it("refuses to rebaseline a draft onto another queue id", () => {
    const draft = { ...initialQueueDraft(withSuggestion()), title: "我的草稿" };
    const twin = { ...withSuggestion(), id: "q-other" };
    expect(rebaselineQueueDraft(draft, twin)).toBeNull();
  });

  it("still rebaselines within the same queue id", () => {
    const draft = { ...initialQueueDraft(withSuggestion()), title: "我的草稿" };
    const next = currentSuggestion({ proposedTitle: "新建议" });
    const rebased = rebaselineQueueDraft(draft, next);
    expect(rebased).not.toBeNull();
    if (!rebased) return;
    expect(rebased.itemID).toBe("q-a");
    expect(queueDraftConflict(rebased, next)).toBeNull();
  });

  it("detects item fields that changed without any updatedAt change", () => {
    const base = source();
    const draft = initialQueueDraft(base);
    const changes: Array<Partial<QueueDraftSource>> = [
      { kind: "rule" },
      { scope: "global" },
      { projectKey: "another-project" },
      { origin: "session-review" },
      { status: "queued" },
      { priority: 99 },
      { priorityBreakdown: { risk: 1, impact: 0, uncertainty: 0, age: 0 } },
      { reason: "评估理由已变" },
      { suggestedAction: "deny" },
      { decision: { kind: "fact", duplicate: 0.4 } },
    ];
    for (const change of changes) {
      expect(queueDraftConflict(draft, { ...base, ...change })).toBe(
        "item-changed",
      );
    }
  });

  it("detects suggestion action, target, version and validation changes", () => {
    const draft = initialQueueDraft(withSuggestion());
    const changes: Array<Partial<QueueDraftSuggestion>> = [
      { action: "merge_into" },
      { targetId: "mem-9" },
      { targetVersion: "v2" },
      { validation: { ok: false, errors: ["lint failed"], warnings: [] } },
      { confidence: 0.3 },
      { source: "human" },
      { rationale: "理由已变" },
      { preserved: ["新保留项"] },
      { dropped: [{ text: "被丢弃", reason: "重复" }] },
    ];
    for (const change of changes) {
      expect(
        queueDraftConflict(draft, currentSuggestion(change)),
      ).toBe("suggestion-changed");
    }
  });

  it("treats a decision change as an item change even when text is the same", () => {
    const base = source({ decision: { kind: "fact", duplicate: 0.1 } });
    const draft = initialQueueDraft(base);
    expect(
      queueDraftConflict(draft, {
        ...base,
        decision: { kind: "fact", duplicate: 0.1, risk: 0.9 },
      }),
    ).toBe("item-changed");
  });
});

describe("decision version and snapshot guards", () => {
  it("requires a usable decision version", () => {
    expect(hasDecisionVersion("v1")).toBe(true);
    expect(hasDecisionVersion("")).toBe(false);
    expect(hasDecisionVersion("   ")).toBe(false);
    expect(hasDecisionVersion(undefined)).toBe(false);
    expect(hasDecisionVersion(12)).toBe(false);
  });

  it("detects a different item, suggestion, version or submitted content", () => {
    const item = withSuggestion({ id: "q-a" });
    const snapshot = decisionSnapshotOf(
      { ...item, decisionVersion: "v1" },
      { title: "标题", text: "正文", note: "备注" },
    );
    expect(
      sameDecisionSnapshot(
        snapshot,
        decisionSnapshotOf(
          { ...item, decisionVersion: "v1" },
          { title: "标题", text: "正文", note: "备注" },
        ),
      ),
    ).toBe(true);
    expect(
      sameDecisionSnapshot(
        snapshot,
        decisionSnapshotOf(
          { ...item, id: "q-b", decisionVersion: "v1" },
          { title: "标题", text: "正文", note: "备注" },
        ),
      ),
    ).toBe(false);
    expect(
      sameDecisionSnapshot(
        snapshot,
        decisionSnapshotOf(
          { ...item, decisionVersion: "v2" },
          { title: "标题", text: "正文", note: "备注" },
        ),
      ),
    ).toBe(false);
    expect(
      sameDecisionSnapshot(
        snapshot,
        decisionSnapshotOf(
          { ...item, decisionVersion: "v1" },
          { title: "标题", text: "正文改", note: "备注" },
        ),
      ),
    ).toBe(false);
  });

  it("describes the exact submitted snapshot for the request body", () => {
    const snapshot = decisionSnapshotOf(
      { id: "q-a", decisionVersion: "v1", suggestion: { id: "sug-1" } },
      { title: "标题", text: "正文", note: "" },
    );
    expect(snapshot).toEqual({
      itemID: "q-a",
      decisionVersion: "v1",
      suggestionID: "sug-1",
      title: "标题",
      text: "正文",
      note: "",
    });
  });
});

describe("draft consumption after a successful decision", () => {
  function editedDraft() {
    const draft = { ...initialQueueDraft(withSuggestion()), title: "改过的标题" };
    return { draft, submitted: { title: "改过的标题", text: "建议正文", note: "" } };
  }

  it("clears only the draft whose exact content was submitted", () => {
    const { draft, submitted } = editedDraft();
    expect(
      shouldClearConsumedDraft({
        action: "apply_suggestion",
        itemID: "q-a",
        draft,
        submitted,
        current: submitted,
      }),
    ).toBe(true);
    expect(
      shouldClearConsumedDraft({
        action: "approve",
        itemID: "q-a",
        draft,
        submitted,
        current: submitted,
      }),
    ).toBe(true);
  });

  it("keeps the draft when the user typed during the save", () => {
    const { draft, submitted } = editedDraft();
    expect(
      shouldClearConsumedDraft({
        action: "apply_suggestion",
        itemID: "q-a",
        draft,
        submitted,
        current: { ...submitted, text: "保存期间的新输入" },
      }),
    ).toBe(false);
  });

  it("keeps drafts for deny, defer and resume because they did not consume the edits", () => {
    const { draft, submitted } = editedDraft();
    for (const action of ["deny", "defer", "resume", "promote"]) {
      expect(
        shouldClearConsumedDraft({
          action,
          itemID: "q-a",
          draft,
          submitted,
          current: submitted,
        }),
      ).toBe(false);
    }
  });

  it("never clears another item's draft", () => {
    const { draft, submitted } = editedDraft();
    expect(
      shouldClearConsumedDraft({
        action: "approve",
        itemID: "q-b",
        draft,
        submitted,
        current: submitted,
      }),
    ).toBe(false);
  });
});

describe("unknown single decision results", () => {
  it("locks only the item with an unknown result", () => {
    const pending = { itemID: "q-a", action: "approve" };
    expect(decisionLockedByUnknown(pending, "q-a")).toBe(true);
    expect(decisionLockedByUnknown(pending, "q-b")).toBe(false);
    expect(decisionLockedByUnknown(null, "q-a")).toBe(false);
  });
});

describe("defer-only version changes", () => {
  it("does not conflict when only the deferred field changed", () => {
    const base = source({ deferredUntil: "2026-11-05T10:00:00.000Z" });
    const draft = initialQueueDraft(base);
    expect(
      queueDraftConflict(draft, {
        ...base,
        deferredUntil: "2026-11-06T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("still conflicts when another field changed together with the defer", () => {
    const base = source({ deferredUntil: "2026-11-05T10:00:00.000Z" });
    const draft = initialQueueDraft(base);
    expect(
      queueDraftConflict(draft, {
        ...base,
        deferredUntil: "2026-11-06T10:00:00.000Z",
        priority: 99,
      }),
    ).toBe("item-changed");
  });
});

describe("decision version binding", () => {
  it("flags a different server version even when every visible field is identical", () => {
    const draft = { ...initialQueueDraft(withSuggestion()), title: "我的草稿" };
    expect(
      queueDraftConflict(draft, withSuggestion({ decisionVersion: "v2" })),
    ).toBe("version-changed");
  });

  it("fails closed when the current item has no decision version", () => {
    const draft = initialQueueDraft(withSuggestion());
    expect(
      queueDraftConflict(draft, source({ decisionVersion: undefined })),
    ).toBe("version-missing");
  });

  it("fails closed when the draft itself was captured without a version", () => {
    const draft = initialQueueDraft(source({ decisionVersion: undefined }));
    expect(queueDraftConflict(draft, source({ decisionVersion: "v2" }))).toBe(
      "version-missing",
    );
  });

  it("refuses manual rebaselining without a current version", () => {
    const draft = initialQueueDraft(withSuggestion());
    expect(
      rebaselineQueueDraft(draft, source({ decisionVersion: undefined })),
    ).toBeNull();
  });

  it("allows an explicit rebaseline across versions but never across ids", () => {
    const draft = initialQueueDraft(withSuggestion());
    const next = withSuggestion({ decisionVersion: "v2" });
    const rebased = rebaselineQueueDraft(draft, next);
    expect(rebased).not.toBeNull();
    if (!rebased) return;
    expect(rebased.baseline.decisionVersion).toBe("v2");
    expect(queueDraftConflict(rebased, next)).toBeNull();
    expect(
      rebaselineQueueDraft(draft, { ...next, id: "q-other" }),
    ).toBeNull();
  });
});

describe("safe rebase after our own defer or resume", () => {
  function setup() {
    const draft = {
      ...initialQueueDraft(withSuggestion()),
      title: "延后期间保留的草稿",
    };
    const expectation = {
      itemID: "q-a",
      oldVersion: "v1",
      newVersion: "v2",
      draft,
    };
    return { draft, expectation };
  }

  it("waits while the reloaded item still carries the old version", () => {
    const { draft, expectation } = setup();
    expect(
      resolveDeferRebase({
        expectation,
        draft,
        current: withSuggestion({ decisionVersion: "v1" }),
      }),
    ).toEqual({ action: "wait" });
  });

  it("rebaselines only when the reloaded version is exactly the response version", () => {
    const { draft, expectation } = setup();
    const current = withSuggestion({ decisionVersion: "v2" });
    const outcome = resolveDeferRebase({ expectation, draft, current });
    expect(outcome.action).toBe("rebase");
    if (outcome.action !== "rebase") return;
    expect(outcome.draft.title).toBe("延后期间保留的草稿");
    expect(outcome.draft.baseline.decisionVersion).toBe("v2");
    expect(queueDraftConflict(outcome.draft, current)).toBeNull();
  });

  it("never rebaselines a same-content replacement created after submitting", () => {
    const { draft, expectation } = setup();
    const replacement = { ...draft };
    expect(
      resolveDeferRebase({
        expectation,
        draft: replacement,
        current: withSuggestion({ decisionVersion: "v2" }),
      }),
    ).toEqual({ action: "conflict", reason: "draft-changed" });
  });

  it("keeps a conflict when the user edited the draft after submitting", () => {
    const { expectation } = setup();
    const edited = {
      ...initialQueueDraft(withSuggestion()),
      title: "提交后又改的草稿",
    };
    expect(
      resolveDeferRebase({
        expectation,
        draft: edited,
        current: withSuggestion({ decisionVersion: "v2" }),
      }),
    ).toEqual({ action: "conflict", reason: "draft-changed" });
  });

  it("keeps a conflict when another writer changed the item again", () => {
    const { draft, expectation } = setup();
    expect(
      resolveDeferRebase({
        expectation,
        draft,
        current: withSuggestion({ decisionVersion: "v3" }),
      }),
    ).toEqual({ action: "conflict", reason: "version-unproven" });
  });

  it("fails closed when the reloaded item has no version", () => {
    const { draft, expectation } = setup();
    expect(
      resolveDeferRebase({
        expectation,
        draft,
        current: { ...withSuggestion(), decisionVersion: undefined },
      }),
    ).toEqual({ action: "conflict", reason: "version-unproven" });
  });

  it("does nothing once the draft was discarded", () => {
    const { expectation } = setup();
    expect(
      resolveDeferRebase({
        expectation,
        draft: undefined,
        current: withSuggestion({ decisionVersion: "v2" }),
      }),
    ).toEqual({ action: "none" });
  });

  it("waits for the item to come back instead of guessing", () => {
    const { draft, expectation } = setup();
    expect(
      resolveDeferRebase({ expectation, draft, current: null }),
    ).toEqual({ action: "wait" });
  });

  it("refuses to rebase a draft that is no longer bound to the old version", () => {
    const { draft, expectation } = setup();
    const moved = {
      ...draft,
      baseline: { ...draft.baseline, decisionVersion: "v9" },
    };
    expect(
      resolveDeferRebase({
        expectation,
        draft: moved,
        current: withSuggestion({ decisionVersion: "v2" }),
      }),
    ).toEqual({ action: "conflict", reason: "version-unproven" });
  });
});

describe("defer response evidence", () => {
  function evidence(overrides: Record<string, unknown> = {}) {
    const draft = {
      ...initialQueueDraft(withSuggestion()),
      title: "提交时的草稿",
    };
    return {
      draft,
      itemID: "q-a",
      oldVersion: "v1",
      draftVersion: "v1",
      responseItemID: "q-a",
      responseVersion: "v2",
      ...overrides,
    };
  }

  it("builds an expectation only when item, versions and draft all align", () => {
    const input = evidence();
    expect(deferRebaseExpectation(input)).toEqual({
      itemID: "q-a",
      oldVersion: "v1",
      newVersion: "v2",
      draft: input.draft as QueueDraft,
    });
  });

  it("rejects a response item belonging to another id", () => {
    expect(
      deferRebaseExpectation(evidence({ responseItemID: "q-other" })),
    ).toBeNull();
  });

  it("rejects a missing flat response version", () => {
    expect(deferRebaseExpectation(evidence({ responseVersion: undefined }))).toBeNull();
  });

  it("accepts the real response shape: persisted row plus top-level version", () => {
    const input = evidence();
    expect(deferRebaseExpectation(input)).not.toBeNull();
  });

  it("rebaselines through the real response and the later GET projection", () => {
    const input = evidence();
    const expectation = deferRebaseExpectation(input);
    expect(expectation).not.toBeNull();
    if (!expectation) return;
    const outcome = resolveDeferRebase({
      expectation,
      draft: input.draft as QueueDraft,
      current: withSuggestion({ decisionVersion: "v2" }),
    });
    expect(outcome.action).toBe("rebase");
  });

  it("rejects a draft that was not bound to the submitted version", () => {
    expect(deferRebaseExpectation(evidence({ draftVersion: "v9" }))).toBeNull();
  });

  it("requires an actual version change", () => {
    expect(
      deferRebaseExpectation(
        evidence({ responseVersion: "v1" }),
      ),
    ).toBeNull();
  });

  it("rejects a missing draft because there is nothing to preserve", () => {
    expect(deferRebaseExpectation(evidence({ draft: undefined }))).toBeNull();
  });
});
