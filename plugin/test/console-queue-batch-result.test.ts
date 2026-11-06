import { describe, expect, it } from "vitest";
import {
  buildBatchExecution,
  classifyBatchSubmitFailure,
  parseBatchPreview,
  parseBatchResults,
  shortItemID,
  summarizeBatchResults,
  unknownSubmissionReport,
  type BatchResultEntry,
} from "../../console/src/pages/queue-batch-result";

function validPreview(): Record<string, unknown> {
  return {
    dryRun: true,
    previewID: "preview-1",
    eligible: [
      {
        id: "a",
        title: "候选 A",
        action: "create",
        confidence: 0.95,
        projectKey: "proj-a",
        proposedTitle: "建议标题 A",
        proposedText: "建议正文 A",
      },
      {
        id: "b",
        title: "候选 B",
        action: "keep_both",
        confidence: 0.92,
        projectKey: "proj-b",
        proposedTitle: "建议标题 B",
        proposedText: "建议正文 B",
      },
    ],
    skipped: 1,
    capped: 1,
    skippedItems: [{ id: "s1", title: "跳过项", reason: "规则需逐条确认" }],
    cappedItems: [{ id: "c1", title: "超限项", reason: "超过本次上限" }],
  };
}

const REQUESTED = ["a", "b", "s1", "c1"];

function parsedPreview() {
  const parsed = parseBatchPreview(validPreview(), REQUESTED);
  if (!parsed.ok) throw new Error(`expected valid preview: ${parsed.reason}`);
  return parsed.preview;
}

describe("batch preview parsing", () => {
  it("keeps every field needed to show what will run", () => {
    const parsed = parseBatchPreview(validPreview(), REQUESTED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.preview.previewID).toBe("preview-1");
    expect(parsed.preview.eligible.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(parsed.preview.eligible[0]).toEqual({
      id: "a",
      title: "候选 A",
      action: "create",
      confidence: 0.95,
      projectKey: "proj-a",
      proposedTitle: "建议标题 A",
      proposedText: "建议正文 A",
    });
    expect(parsed.preview.skippedItems[0].reason).toBe("规则需逐条确认");
    expect(parsed.preview.cappedItems[0].reason).toBe("超过本次上限");
  });

  it("fails closed when the preview id is missing", () => {
    const raw = validPreview();
    delete raw.previewID;
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("previewID");
  });

  it("fails closed when the response is not a dry run", () => {
    const parsed = parseBatchPreview({ ...validPreview(), dryRun: false }, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("dryRun");
  });

  it("fails closed when an eligible item cannot be shown in full", () => {
    const raw = validPreview();
    const eligible = raw.eligible as Array<Record<string, unknown>>;
    delete eligible[0].proposedText;
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("proposedText");
  });

  it("fails closed when an eligible item lacks its project", () => {
    const raw = validPreview();
    const eligible = raw.eligible as Array<Record<string, unknown>>;
    eligible[1].projectKey = "";
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("projectKey");
  });

  it("fails closed on duplicate eligible ids", () => {
    const raw = validPreview();
    const eligible = raw.eligible as Array<Record<string, unknown>>;
    eligible[1].id = "a";
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("重复");
  });

  it("fails closed when skipped counts and detail disagree", () => {
    const parsed = parseBatchPreview({ ...validPreview(), skipped: 3 }, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("跳过");
  });

  it("fails closed when capped detail is missing", () => {
    const raw = validPreview();
    delete raw.cappedItems;
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("超限");
  });
});

describe("batch preview reconciliation with the requested ids", () => {
  it("rejects a duplicated id inside the skipped list", () => {
    const raw = validPreview();
    raw.skippedItems = [
      { id: "s1", reason: "重复一" },
      { id: "s1", reason: "重复二" },
    ];
    raw.skipped = 2;
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("重复");
  });

  it("rejects a duplicated id inside the capped list", () => {
    const raw = validPreview();
    raw.cappedItems = [
      { id: "c1", reason: "重复一" },
      { id: "c1", reason: "重复二" },
    ];
    raw.capped = 2;
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("重复");
  });

  it("rejects an id that appears in both skipped and capped lists", () => {
    const raw = validPreview();
    raw.skippedItems = [{ id: "c1", reason: "跳过" }];
    raw.cappedItems = [{ id: "c1", reason: "超限" }];
    raw.skipped = 1;
    raw.capped = 1;
    const parsed = parseBatchPreview(raw, ["a", "b", "c1", "s1"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("重复");
  });

  it("rejects an eligible id that also appears in an exclusion list", () => {
    const raw = validPreview();
    raw.skippedItems = [{ id: "a", reason: "又被跳过" }];
    raw.skipped = 1;
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("重复");
  });

  it("rejects a preview that omits a requested id", () => {
    const parsed = parseBatchPreview(validPreview(), [...REQUESTED, "z"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("遗漏");
  });

  it("rejects a preview that reports an id outside the request", () => {
    const parsed = parseBatchPreview(validPreview(), ["a", "b", "s1"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("请求之外");
  });

  it("rejects a duplicated requested id", () => {
    const parsed = parseBatchPreview(validPreview(), ["a", "a", "b", "s1", "c1"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("请求");
    expect(parsed.reason).toContain("重复");
  });

  it("accepts a complete preview whose eligible order differs from the request", () => {
    const raw = validPreview();
    raw.eligible = (raw.eligible as Array<Record<string, unknown>>).slice().reverse();
    const parsed = parseBatchPreview(raw, REQUESTED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.preview.eligible.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(new Set(parsed.preview.eligible.map((entry) => entry.id))).toEqual(
      new Set(["a", "b"]),
    );
  });
});

describe("batch execution payload", () => {
  it("binds the exact preview id list and action", () => {
    const preview = parsedPreview();
    const execution = buildBatchExecution(preview);
    expect(execution).toEqual({
      previewID: "preview-1",
      ids: ["a", "b"],
      action: "apply_suggestion",
      dryRun: false,
    });
  });

  it("never widens the list with ids outside the preview", () => {
    const preview = parsedPreview();
    const execution = buildBatchExecution(preview);
    expect(execution.ids).toHaveLength(preview.eligible.length);
    expect(new Set(execution.ids).size).toBe(execution.ids.length);
  });
});

describe("batch result parsing", () => {
  it("accepts a well-formed result list", () => {
    const parsed = parseBatchResults([
      { id: "a", ok: true },
      { id: "b", ok: false, error: "内容超长" },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.results).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: false, error: "内容超长" },
    ]);
  });

  it("fails closed when a result has no boolean outcome", () => {
    const parsed = parseBatchResults([{ id: "a", ok: "yes" }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("ok");
  });

  it("fails closed when the response has no result list", () => {
    const parsed = parseBatchResults({ results: [] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("results");
  });
});

describe("batch result summary", () => {
  const scope = () => {
    const preview = parsedPreview();
    return {
      ids: preview.eligible.map((entry) => entry.id),
      skipped: preview.skippedItems,
      capped: preview.cappedItems,
      previewID: preview.previewID,
    };
  };

  it("classifies results regardless of their order", () => {
    const results: BatchResultEntry[] = [
      { id: "b", ok: true },
      { id: "a", ok: true },
    ];
    const summary = summarizeBatchResults(scope(), results);
    expect(summary.status).toBe("ok");
    expect(summary.succeeded).toEqual(["a", "b"]);
    expect(summary.failed).toEqual([]);
    expect(summary.unresolved).toEqual([]);
    expect(summary.retryIds).toEqual([]);
    expect(summary.skipped.map((entry) => entry.id)).toEqual(["s1"]);
    expect(summary.capped.map((entry) => entry.id)).toEqual(["c1"]);
    expect(summary.message).toBe("成功 2 条，跳过 1 条，超限 1 条。");
  });

  it("only marks failed items as retryable and keeps skipped details out of failures", () => {
    const results: BatchResultEntry[] = [
      { id: "a", ok: true },
      { id: "b", ok: false, error: "内容已被修改，请重新生成建议" },
    ];
    const summary = summarizeBatchResults(scope(), results);
    expect(summary.status).toBe("partial");
    expect(summary.succeeded).toEqual(["a"]);
    expect(summary.failed).toEqual([
      { id: "b", error: "内容已被修改，请重新生成建议" },
    ]);
    expect(summary.unresolved).toEqual([]);
    expect(summary.retryIds).toEqual(["b"]);
    expect(summary.message).toContain("失败 1 条");
    expect(summary.error).toContain("内容已被修改，请重新生成建议");
    expect(summary.error).not.toContain("s1");
    expect(summary.error).not.toContain("c1");
  });

  it("treats a missing result as unknown and never as safely retryable", () => {
    const summary = summarizeBatchResults(scope(), [{ id: "a", ok: true }]);
    expect(summary.status).toBe("unknown");
    expect(summary.succeeded).toEqual(["a"]);
    expect(summary.unresolved).toEqual(["b"]);
    expect(summary.retryIds).toEqual([]);
    expect(summary.message).toContain("未返回 1 条");
    expect(summary.message).toContain("状态未知");
    expect(summary.error).toContain("b");
    expect(summary.error).toContain("状态未知");
    expect(summary.error).not.toContain("请重试");
    expect(summary.needsRefresh).toBe(true);
  });

  it("treats duplicate results for one id as unknown, not success", () => {
    const summary = summarizeBatchResults(scope(), [
      { id: "a", ok: true },
      { id: "b", ok: true },
      { id: "b", ok: false, error: "conflicting" },
    ]);
    expect(summary.status).toBe("unknown");
    expect(summary.succeeded).toEqual(["a"]);
    expect(summary.failed).toEqual([]);
    expect(summary.unresolved).toEqual(["b"]);
    expect(summary.retryIds).toEqual([]);
    expect(summary.error).toContain("重复");
  });

  it("ignores results for ids that were not part of the confirmed list", () => {
    const summary = summarizeBatchResults(scope(), [
      { id: "a", ok: true },
      { id: "b", ok: true },
      { id: "outside", ok: false, error: "not requested" },
    ]);
    expect(summary.status).toBe("ok");
    expect(summary.succeeded).toEqual(["a", "b"]);
    expect(summary.failed).toEqual([]);
    expect(summary.error).toBe("");
  });

  it("never treats skipped or capped items as failures", () => {
    const preview = parsedPreview();
    const summary = summarizeBatchResults(
      {
        ids: preview.eligible.map((entry) => entry.id),
        skipped: preview.skippedItems,
        capped: preview.cappedItems,
      },
      [{ id: "a", ok: true }, { id: "b", ok: true }],
    );
    expect(summary.status).toBe("ok");
    expect(summary.retryIds).toEqual([]);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.capped).toHaveLength(1);
  });
});

describe("unknown submit state", () => {
  it("asks for a refresh instead of suggesting an automatic resubmit", () => {
    const report = unknownSubmissionReport(
      { ids: ["a", "b"], previewID: "preview-1" },
      "network disconnected",
    );
    expect(report.status).toBe("unknown");
    expect(report.succeeded).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.retryIds).toEqual([]);
    expect(report.needsRefresh).toBe(true);
    expect(report.unresolved).toEqual(["a", "b"]);
    expect(report.message).toContain("状态未知");
    expect(report.message).toContain("刷新");
    expect(report.message).not.toContain("重试");
    expect(report.error).toContain("network disconnected");
    expect(report.error).not.toContain("请重试");
  });
});

describe("batch submit failure classification", () => {
  it("treats the server's explicit preview rejection as not submitted", () => {
    expect(classifyBatchSubmitFailure("BATCH_PREVIEW_REJECTED")).toBe(
      "not-submitted",
    );
  });

  it("keeps every other failure unknown", () => {
    expect(classifyBatchSubmitFailure(undefined)).toBe("unknown");
    expect(classifyBatchSubmitFailure("OTHER_CODE")).toBe("unknown");
    expect(classifyBatchSubmitFailure("batch_preview_rejected")).toBe("unknown");
  });
});

describe("id clues for same-title rows", () => {
  it("keeps short ids distinguishable", () => {
    const first = shortItemID("queue_aaaaaaaa-1111");
    const second = shortItemID("queue_aaaaaaaa-2222");
    expect(first).not.toBe(second);
    expect(first).toContain("…");
    expect(shortItemID("q1")).toBe("q1");
  });

  it("never returns an empty clue", () => {
    expect(shortItemID("")).toBe("");
  });
});
