import { describe, expect, it } from "vitest";
import {
  auditFindingLink,
  findingsForQueueItem,
  markTargetCheck,
  parseRouteHash,
  queueItemLink,
  resolveAuditTarget,
  resolveFindingQueueLinks,
  resolveQueueTarget,
  targetCheckHandled,
  targetConsumed,
  consumeTarget,
} from "../../console/src/pages/audit-links";

const queueA = { id: "q-a", title: "队列 A" };
const queueB = { id: "q/b 记忆 #1 ?&%+", title: "队列 B" };
const queueSnapshot = [queueA, queueB];

describe("console route hashes", () => {
  it("keeps every legacy tab hash working", () => {
    for (const tab of ["queue", "skills", "map", "audit", "health", "settings"]) {
      expect(parseRouteHash(`#${tab}`)).toEqual({ tab });
    }
  });

  it("parses memory graph subviews and rejects unknown ones", () => {
    expect(parseRouteHash("#map/architecture")).toEqual({
      tab: "map",
      graphView: "architecture",
    });
    expect(parseRouteHash("#map/similarity")).toEqual({
      tab: "map",
      graphView: "similarity",
    });
    expect(parseRouteHash("#map/not-a-view")).toBeNull();
    expect(parseRouteHash("#map/architecture/extra")).toBeNull();
  });

  it("parses and rebuilds a queue target roundtrip with special characters", () => {
    const link = queueItemLink(queueB.id);
    expect(link.startsWith("#queue/")).toBe(true);
    expect(link).not.toContain(" ");
    expect(parseRouteHash(link)).toEqual({ tab: "queue", queueItemID: queueB.id });
  });

  it("parses and rebuilds an audit finding roundtrip with its report version", () => {
    const findingID = "finding_1/规则 #真?&%";
    const generatedAt = "2026-11-05T10:20:30.000Z";
    const link = auditFindingLink(findingID, generatedAt);
    expect(link.startsWith("#audit/finding/")).toBe(true);
    expect(parseRouteHash(link)).toEqual({
      tab: "audit",
      auditFindingID: findingID,
      auditReportAt: generatedAt,
    });
  });

  it("accepts an audit finding link without a report version", () => {
    expect(parseRouteHash(`#audit/finding/${encodeURIComponent("finding_2")}`)).toEqual({
      tab: "audit",
      auditFindingID: "finding_2",
    });
  });

  it("ignores unknown hashes instead of guessing a target", () => {
    expect(parseRouteHash("#nope")).toBeNull();
    expect(parseRouteHash("")).toBeNull();
    expect(parseRouteHash("#queue/a/b")).toBeNull();
    expect(parseRouteHash("#audit/finding")).toBeNull();
    expect(parseRouteHash("#queue/%E0%A4%A")).toBeNull();
  });
});

describe("audit to queue evidence links", () => {
  it("links only queue ids that exist in the queue snapshot", () => {
    const resolved = resolveFindingQueueLinks(
      {
        id: "finding_1",
        kind: "duplicate",
        title: "重复候选",
        itemIDs: ["mem-1", "q-a", "q-a"],
      },
      queueSnapshot,
    );
    expect(resolved.links).toEqual([{ id: "q-a", title: "队列 A" }]);
    expect(resolved.otherIDs).toEqual(["mem-1"]);
    expect(resolved.missingQueueIDs).toEqual([]);
  });

  it("reports a queue finding whose queue target disappeared", () => {
    const resolved = resolveFindingQueueLinks(
      { id: "finding_9", kind: "queue", title: "队列积压", itemIDs: ["gone"] },
      queueSnapshot,
    );
    expect(resolved.links).toEqual([]);
    expect(resolved.missingQueueIDs).toEqual(["gone"]);
    expect(resolved.otherIDs).toEqual([]);
  });

  it("never links by title or text similarity", () => {
    const resolved = resolveFindingQueueLinks(
      { id: "finding_2", kind: "queue", title: "队列 A", itemIDs: [queueB.id] },
      queueSnapshot,
    );
    expect(resolved.links).toEqual([{ id: queueB.id, title: "队列 B" }]);
  });

  it("finds only findings whose evidence contains the exact queue id", () => {
    const findings = [
      { id: "finding_1", title: "同一标题", kind: "queue", severity: "warning", itemIDs: ["q-a"] },
      { id: "finding_2", title: "同一标题", kind: "queue", severity: "warning", itemIDs: [queueB.id] },
      { id: "finding_3", title: "同一标题", kind: "capacity", severity: "info", itemIDs: [] },
    ];
    expect(findingsForQueueItem("q-a", findings).map((entry) => entry.id)).toEqual(["finding_1"]);
    expect(findingsForQueueItem("Q-A", findings)).toEqual([]);
    expect(findingsForQueueItem("finding_1", findings)).toEqual([]);
  });
});

describe("queue target resolution", () => {
  it("distinguishes visible, filtered, stale-list and missing queue targets", () => {
    expect(resolveQueueTarget("q-a", [queueA], queueSnapshot, true)).toBe("visible");
    expect(resolveQueueTarget(queueB.id, [queueA], queueSnapshot, true)).toBe("filtered");
    expect(resolveQueueTarget(queueB.id, [queueA], queueSnapshot, false)).toBe(
      "stale-list",
    );
    expect(resolveQueueTarget("gone", [queueA], queueSnapshot, true)).toBe("missing");
    expect(resolveQueueTarget("gone", [], [], false)).toBe("missing");
  });
});

describe("audit target resolution", () => {
  const report = {
    generatedAt: "2026-11-05T10:20:30.000Z",
    findings: [{ id: "finding_1" }],
  };

  it("resolves the finding from the same report", () => {
    expect(
      resolveAuditTarget(
        { id: "finding_1", reportAt: "2026-11-05T10:20:30.000Z" },
        report,
      ),
    ).toEqual({ status: "current", findingID: "finding_1" });
  });

  it("refuses to resolve an id from another report generation", () => {
    expect(
      resolveAuditTarget(
        { id: "finding_1", reportAt: "2026-11-04T00:00:00.000Z" },
        report,
      ),
    ).toEqual({ status: "stale" });
  });

  it("requires a report version for direct finding links", () => {
    expect(resolveAuditTarget({ id: "finding_1" }, report)).toEqual({
      status: "unversioned",
    });
  });

  it("reports a finding that is no longer in the current report", () => {
    expect(
      resolveAuditTarget(
        { id: "finding_9", reportAt: "2026-11-05T10:20:30.000Z" },
        report,
      ),
    ).toEqual({ status: "missing" });
  });

  it("waits for the report before judging the target", () => {
    expect(resolveAuditTarget({ id: "finding_1" }, undefined)).toEqual({
      status: "loading",
    });
    expect(resolveAuditTarget(undefined, report)).toEqual({ status: "none" });
  });
});

describe("deep link target recheck after reloads", () => {
  it("does not treat an unmarked target as handled", () => {
    expect(targetCheckHandled(null, "q-a|", 1)).toBe(false);
    expect(targetCheckHandled(undefined, "q-a|", 1)).toBe(false);
  });

  it("handles the same key only within the same queue request generation", () => {
    const mark = markTargetCheck("q-a|", 4);
    expect(targetCheckHandled(mark, "q-a|", 4)).toBe(true);
  });

  it("invalidates the mark when the queue request generation advances", () => {
    const mark = markTargetCheck("q-a|", 4);
    expect(targetCheckHandled(mark, "q-a|", 5)).toBe(false);
  });

  it("invalidates the mark when the target or filter changes", () => {
    const mark = markTargetCheck("q-a|", 4);
    expect(targetCheckHandled(mark, "q-b|", 4)).toBe(false);
    expect(targetCheckHandled(mark, "q-a|kind=rule", 4)).toBe(false);
  });
});

describe("deep link target consumption", () => {
  it("keeps selecting only after the target was consumed", () => {
    expect(targetConsumed(null, "q-a")).toBe(false);
    expect(targetConsumed(consumeTarget("q-a"), "q-a")).toBe(true);
  });

  it("does not consider another target or no target as consumed", () => {
    const consumed = consumeTarget("q-a");
    expect(targetConsumed(consumed, "q-b")).toBe(false);
    expect(targetConsumed(consumed, undefined)).toBe(false);
  });
});
