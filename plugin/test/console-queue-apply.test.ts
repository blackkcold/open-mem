import { describe, expect, it } from "vitest";
import { suggestionApplyState } from "../../console/src/pages/queue-apply";
import type { Suggestion } from "../../console/src/types";

function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: "sug_1",
    queueID: "queue_1",
    action: "merge_into",
    proposedTitle: "建议标题",
    proposedText: "建议正文",
    preserved: ["建议正文"],
    dropped: [],
    rationale: "test",
    confidence: 0.9,
    source: "composer",
    validation: { ok: true, errors: [], warnings: [] },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("suggestionApplyState", () => {
  it("does not let a title-only edit enable an invalid body", () => {
    const state = suggestionApplyState({
      suggestion: suggestion({
        validation: { ok: false, errors: ["正文校验失败"], warnings: [] },
      }),
      suggestionState: "ready",
      title: "只改标题",
      text: "建议正文",
      overLimit: false,
    });
    expect(state.titleEdited).toBe(true);
    expect(state.bodyEdited).toBe(false);
    expect(state.canApply).toBe(false);
  });

  it("allows a body edit for a failed suggestion", () => {
    const state = suggestionApplyState({
      suggestion: suggestion({
        validation: { ok: false, errors: ["正文校验失败"], warnings: [] },
      }),
      suggestionState: "failed",
      title: "建议标题",
      text: "人工修改后的正文",
      overLimit: false,
    });
    expect(state.bodyEdited).toBe(true);
    expect(state.canApply).toBe(true);
  });

  it("treats whitespace-only edits as unchanged", () => {
    const state = suggestionApplyState({
      suggestion: suggestion(),
      suggestionState: "ready",
      title: "建议标题",
      text: "  建议正文  ",
      overLimit: false,
    });
    expect(state.bodyEdited).toBe(false);
    expect(state.canApply).toBe(true);
  });

  it("disables an unedited pending or failed suggestion", () => {
    for (const suggestionState of ["pending", "failed"] as const) {
      const state = suggestionApplyState({
        suggestion: suggestion(),
        suggestionState,
        title: "建议标题",
        text: "建议正文",
        overLimit: false,
      });
      expect(state.canApply, suggestionState).toBe(false);
    }
  });

  it("allows an unedited ready suggestion but not one over the limit", () => {
    expect(
      suggestionApplyState({
        suggestion: suggestion(),
        suggestionState: "ready",
        title: "建议标题",
        text: "建议正文",
        overLimit: false,
      }).canApply,
    ).toBe(true);
    expect(
      suggestionApplyState({
        suggestion: suggestion(),
        suggestionState: "ready",
        title: "建议标题",
        text: "建议正文",
        overLimit: true,
      }).canApply,
    ).toBe(false);
  });
});
