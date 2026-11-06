import { Store, newId } from "./store.js";
import type { AutoMemConfig, Item, QueueItem } from "./types.js";
import { lintText } from "./linter.js";
import { computePriority } from "./priority.js";
import { admitNewItem } from "./capacity.js";
import { applySuggestion, type RelationWarning } from "./apply.js";
import { rebuildAutoFiles } from "./rebuild.js";
import { canPromote } from "./memory/promotion.js";
import {
  findWriteConflicts,
  isHardWriteBlock,
  type WriteConflict,
} from "./memory/write-guard.js";
import type { RelationKind } from "./relations.js";
import { queueItemSnapshotVersion } from "./fingerprint.js";
import {
  BATCH_APPLY_CONFIDENCE_FLOOR,
  batchItemNeedsIndividualReview,
  batchSuggestionRejection,
} from "./batch-policy.js";

export type QueueAction =
  | "approve"
  | "deny"
  | "edit"
  | "defer"
  | "resume"
  | "apply_suggestion"
  | "promote";

export interface QueueDecision {
  action: QueueAction;
  text?: string;
  title?: string;
  note?: string;
  /** Required for promote; only project or global are valid targets. */
  targetScope?: "project" | "global";
  /** Project identity for a project promotion. */
  projectKey?: string;
  /** Set only by a user-facing surface (console / token-authenticated API). */
  confirmedByUser?: boolean;
  /** Full queue snapshot value the caller displayed before confirming. */
  expectedVersion?: string;
  /** Required when a queue item already has a suggestion the user chose to skip. */
  ignoreSuggestion?: boolean;
  /** Relations the caller reviewed and explicitly accepted, bound to their version. */
  acknowledgedRelations?: Array<{
    id: string;
    relation: RelationKind;
    version: string;
  }>;
}

/** Trusted internal surface label; never parsed from an HTTP body. */
export type DecisionSource = "local-token-api" | "agent-tool" | "internal";

export interface DecisionOrigin {
  source: DecisionSource;
}

export interface QueueActionResult {
  ok: boolean;
  error?: string;
  /** True when the caller's displayed queue snapshot is stale, or a relation needs acknowledgement. */
  conflict?: boolean;
  /** Machine-readable conflict class for the console. */
  code?: "RELATION_ACK_REQUIRED";
  /** Relations that must be shown before an explicit acknowledgement. */
  conflicts?: WriteConflict[];
  /** Non-blocking relation evidence recorded by an apply create/keep_both. */
  relationWarnings?: RelationWarning[];
  item?: Item;
  target?: string;
  journalID?: string;
  /** Actual persisted snapshot after a successful defer/resume. */
  decisionVersion?: string;
}

/** Internal batch context; never parsed from an HTTP body. */
export interface BatchExecutionContext {
  expectedContentHash: string;
  action: QueueAction;
  minConfidence?: number;
}

function unacknowledgedConflicts(
  conflicts: WriteConflict[],
  acknowledged: QueueDecision["acknowledgedRelations"],
): WriteConflict[] {
  return conflicts.filter(
    (conflict) =>
      conflict.relation === "conflict" &&
      !(acknowledged ?? []).some(
        (entry) =>
          entry.id === conflict.id &&
          entry.relation === conflict.relation &&
          entry.version === conflict.version,
      ),
  );
}

export async function applyQueueDecision(
  store: Store,
  config: AutoMemConfig,
  id: string,
  decision: QueueDecision,
  batchContext?: BatchExecutionContext,
  origin?: DecisionOrigin,
): Promise<QueueActionResult> {
  const key = `queue-action:${id}`;
  const token = await store.claim(key, 60_000);
  if (!token) return { ok: false, error: "该条目正在处理，请稍后刷新" };
  try {
    return await store.transaction(async () => await store.ownsClaim(key, token)
      ? applyQueueDecisionUnlocked(store, config, id, decision, batchContext, origin)
      : { ok: false, error: "操作租约已失效，请刷新重试" });
  } finally {
    await store.releaseReservation(key, token);
  }
}

async function applyQueueDecisionUnlocked(
  store: Store,
  config: AutoMemConfig,
  id: string,
  decision: QueueDecision,
  batchContext?: BatchExecutionContext,
  origin?: DecisionOrigin,
): Promise<QueueActionResult> {
  const queue = await store.listQueue();
  const found = queue.find((item) => item.id === id);
  if (!found) return { ok: false, error: "queue item not found" };
  if (
    decision.expectedVersion !== undefined &&
    queueItemSnapshotVersion(found) !== decision.expectedVersion
  ) {
    return {
      ok: false,
      conflict: true,
      error: "队列条目已变化，请刷新后重试",
    };
  }
  const source = origin?.source ?? "internal";

  if (batchContext) {
    if (decision.action !== batchContext.action) {
      return { ok: false, error: "批量动作与内部上下文不一致" };
    }
    if (queueItemSnapshotVersion(found) !== batchContext.expectedContentHash) {
      return { ok: false, error: "队列条目已在批量筛选后变更，请重新筛选" };
    }
    if (decision.action === "apply_suggestion") {
      const rejection = batchSuggestionRejection(
        found,
        batchContext.minConfidence ?? BATCH_APPLY_CONFIDENCE_FLOOR,
      );
      if (rejection) {
        return { ok: false, error: `批量建议不再符合安全策略：${rejection}` };
      }
    } else if (!["deny", "defer", "resume"].includes(decision.action)) {
      return { ok: false, error: "批量动作不在安全策略内" };
    } else if (batchItemNeedsIndividualReview(found)) {
      return { ok: false, error: "规则与复盘候选不能批量处理，请逐条确认" };
    }
  }

  // Review candidates are a human-in-the-loop lane: an agent-invoked tool call
  // must not touch them at all (approve, deny, edit, defer or apply).
  const reviewLane =
    found.origin === "session-review" || found.reviewID !== undefined;
  if (reviewLane && decision.confirmedByUser !== true) {
    return {
      ok: false,
      error: "复盘候选只能由用户在控制台处理",
    };
  }
  if (found.kind === "rule" && ["approve", "apply_suggestion"].includes(decision.action) && decision.confirmedByUser !== true) {
    return { ok: false, error: "规则需要用户在控制台确认" };
  }

  if (
    found.scope === "session" &&
    (decision.action === "approve" || decision.action === "apply_suggestion")
  ) {
    return {
      ok: false,
      error: "session 条目只能通过 promote 提升到 project/global",
    };
  }

  if (decision.action === "promote") {
    const targetScope = decision.targetScope;
    if (targetScope !== "project" && targetScope !== "global") {
      return { ok: false, error: "invalid target scope" };
    }
    const projectKey =
      targetScope === "project"
        ? (decision.projectKey ?? found.projectKey)
        : undefined;
    if (targetScope === "project" && found.projectKey && projectKey !== found.projectKey) {
      return { ok: false, error: "不能提升到其他项目" };
    }
    const lint = lintText({ title: found.title, text: found.text, kind: found.kind, scope: targetScope,
      maxChars: found.kind === "rule" ? config.thresholds.ruleMaxChars : config.thresholds.memoryMaxChars,
      titleMaxChars: config.thresholds.titleMaxChars });
    if (!lint.ok) return { ok: false, error: lint.errors.join("; ") };
    const existing = (await store.listItems()).filter(
      (item) => item.status === "auto" || item.status === "promoted",
    );
    const gate = canPromote(
      {
        id: found.id,
        title: found.title,
        text: found.text,
        kind: found.kind,
        scope: found.scope,
        taskOnly: found.reason.includes("task-only"),
        evidenceCount: found.evidence?.length ?? 0,
      },
      {
        target: targetScope,
        confirmedByUser: decision.confirmedByUser === true,
        projectKey,
        existing,
        queue: queue.filter((entry) => entry.id !== found.id),
      },
    );
    let promoteAcknowledgements: QueueDecision["acknowledgedRelations"];
    if (!gate.ok) {
      const conflicts = gate.conflicts ?? [];
      const unacknowledged = unacknowledgedConflicts(
        conflicts,
        decision.acknowledgedRelations,
      );
      if (unacknowledged.length > 0) {
        return {
          ok: false,
          conflict: true,
          code: "RELATION_ACK_REQUIRED",
          conflicts: unacknowledged,
          error: "存在需要确认的关系",
        };
      }
      promoteAcknowledgements = decision.acknowledgedRelations?.filter((entry) =>
        conflicts.some(
          (conflict) =>
            conflict.id === entry.id &&
            conflict.relation === entry.relation &&
            conflict.version === entry.version,
        ),
      );
      const hardBlocks = conflicts.filter((entry) => isHardWriteBlock(entry.relation));
      if (hardBlocks.length > 0) {
        const first = hardBlocks[0];
        return {
          ok: false,
          conflicts: hardBlocks,
          error:
            first.relation === "classification-mismatch"
              ? `与现有条目分类不一致：${first.title || first.id}。请先处理分类，再提升。`
              : `与现有条目重复或已覆盖：${first.title || first.id}。请勿重复提升。`,
        };
      }
      // Every reported conflict was acknowledged; a hard block would have
      // arrived above and still stops here.
      if (conflicts.length === 0) {
        return { ok: false, error: gate.reason };
      }
    }
    const admission = await admitNewItem(store, config, found.kind);
    if (!admission.ok) return { ok: false, error: admission.reason };

    const now = new Date().toISOString();
    const item: Item = {
      id: newId("item"),
      title: found.title,
      text: found.text,
      kind: found.kind,
      scope: targetScope,
      project: found.project,
      projectKey,
      status: "auto",
      manual: true,
      source: found.source,
      createdAt: now,
      updatedAt: now,
      decision: found.decision,
      priority: found.priority,
      priorityBreakdown: found.priorityBreakdown,
      seenCount: 1,
      lastSeenAt: now,
      sources: found.sources ?? [found.source],
      evidence: found.evidence,
      tags: [...(found.tags ?? []), found.id],
    };
    const recoveryID = await store.saveQueueRecovery(found, item);
    await store.appendItem(item);
    await store.removeQueue(found.id);
    await rebuildAutoFiles(store);
    await store.incrementStat("promotionApplied");
    await store.appendChangelog({
      action: "promote",
      recoveryID,
      queueID: found.id,
      itemID: item.id,
      target: targetScope,
      projectKey,
      source,
      acknowledgedRelations:
        promoteAcknowledgements && promoteAcknowledgements.length > 0
          ? promoteAcknowledgements
          : undefined,
    });
    return { ok: true, item, target: targetScope };
  }

  if (decision.action === "apply_suggestion") {
    const result = await applySuggestion(store, config, id, {
      title: decision.title,
      text: decision.text,
      note: decision.note,
    });
    if (!result.ok) return { ok: false, error: result.error };
    await store.appendChangelog({
      action: "apply_suggestion_surface",
      queueID: id,
      decision: "apply_suggestion",
      journalID: result.journalID,
      source,
    });
    const nextQueue = await store.listQueue();
    return {
      ok: true,
      item: nextQueue.find((item) => item.id === id),
      target: result.target?.id ?? result.item?.id,
      journalID: result.journalID,
      relationWarnings: result.relationWarnings,
    };
  }

  if (decision.action === "approve") {
    if (found.kind === "skill") {
      return { ok: false, error: "skill candidates need a draft; use the Skill Review flow" };
    }
    if (found.suggestion && decision.ignoreSuggestion !== true) {
      return {
        ok: false,
        error: "该候选已有合并建议；请先处理建议，或显式忽略后再批准",
      };
    }

    const title =
      decision.confirmedByUser === true ? (decision.title ?? found.title) : found.title;
    const text =
      decision.confirmedByUser === true ? (decision.text ?? found.text) : found.text;
    const lint = lintText({
      title,
      text,
      kind: found.kind,
      scope: found.scope,
      maxChars:
        found.kind === "rule"
          ? config.thresholds.ruleMaxChars
          : config.thresholds.memoryMaxChars,
      titleMaxChars: config.thresholds.titleMaxChars,
    });
    if (!lint.ok) return { ok: false, error: `linter: ${lint.errors.join("; ")}` };

    const guard = findWriteConflicts(
      {
        id: found.id,
        title,
        text,
        kind: found.kind,
        scope: found.scope,
        projectKey: found.projectKey,
      },
      [...(await store.listItems()), ...queue],
      { excludeID: found.id },
    );
    if (guard.unsafe) return { ok: false, error: guard.unsafe };
    const hardBlocks = guard.conflicts.filter((entry) => isHardWriteBlock(entry.relation));
    if (hardBlocks.length > 0) {
      const first = hardBlocks[0];
      return {
        ok: false,
        conflicts: hardBlocks,
        error:
          first.relation === "classification-mismatch"
            ? `与现有条目分类不一致：${first.title || first.id}。请先处理分类，再批准。`
            : `与现有条目重复或已覆盖：${first.title || first.id}。请使用拒绝或合并路径。`,
      };
    }
    const conflictList = guard.conflicts.filter((entry) => entry.relation === "conflict");
    const unacknowledged = unacknowledgedConflicts(
      conflictList,
      decision.acknowledgedRelations,
    );
    if (unacknowledged.length > 0) {
      return {
        ok: false,
        conflict: true,
        code: "RELATION_ACK_REQUIRED",
        conflicts: conflictList,
        error: "存在需要确认的关系",
      };
    }

    const admission = await admitNewItem(store, config, found.kind);
    if (!admission.ok) return { ok: false, error: admission.reason ?? "容量不足" };

    const target = found.kind === "rule" ? "AUTO_RULES.md" : "AUTO_MEMORY.md";
    const meta = {
      queueID: found.id,
      kind: found.kind,
      scope: found.scope,
      approvedBy: "user",
      source: found.source,
    };
    if (found.kind === "rule") await store.appendAutoRule(text, meta);
    else await store.appendAutoMemory(text, meta);

    const now = new Date().toISOString();
    const item: Item = {
      id: newId("item"),
      title,
      text,
      kind: found.kind,
      scope: found.scope,
      project: found.project,
      projectKey: found.projectKey,
      status: "auto",
      manual: true,
      source: found.source,
      createdAt: now,
      updatedAt: now,
      decision: found.decision,
      priority: found.priority,
      priorityBreakdown: found.priorityBreakdown,
      tags: [...(found.tags ?? []), found.id],
      seenCount: 1,
      lastSeenAt: now,
      sources: [found.source],
    };
    const recoveryID = await store.saveQueueRecovery(found, item);
    await store.appendItem(item);
    await store.removeQueue(found.id);
    await rebuildAutoFiles(store);
    await store.incrementStat("suggestionApplied");
    const editedFields: string[] = [];
    if (title !== found.title) editedFields.push("title");
    if (text !== found.text) editedFields.push("text");
    const acknowledged = decision.acknowledgedRelations?.filter((entry) =>
      conflictList.some(
        (conflict) =>
          conflict.id === entry.id &&
          conflict.relation === entry.relation &&
          conflict.version === entry.version,
      ),
    );
    await store.appendChangelog({
      action: "approve",
      recoveryID,
      queueID: found.id,
      itemID: item.id,
      target,
      note: decision.note,
      source,
      humanEdited: editedFields.length > 0 || undefined,
      editedFields: editedFields.length > 0 ? editedFields : undefined,
      ignoredSuggestion:
        found.suggestion !== undefined && decision.ignoreSuggestion === true
          ? true
          : undefined,
      acknowledgedRelations:
        acknowledged && acknowledged.length > 0 ? acknowledged : undefined,
    });
    return { ok: true, item: found, target };
  }

  if (decision.action === "deny") {
    const now = new Date().toISOString();
    const item: Item = {
      id: newId("item"),
      title: found.title,
      text: found.text,
      kind: found.kind,
      scope: found.scope,
      project: found.project,
      projectKey: found.projectKey,
      status: "archived",
      source: found.source,
      createdAt: now,
      updatedAt: now,
      decision: found.decision,
      tags: [...(found.tags ?? []), found.id],
    };
    const recoveryID = await store.saveQueueRecovery(found, item);
    await store.appendItem(item);
    await store.removeQueue(found.id);
    await store.incrementStat("suggestionRejected");
    await store.appendChangelog({
      action: "deny",
      recoveryID,
      queueID: found.id,
      itemID: item.id,
      note: decision.note,
      source,
    });
    return { ok: true, item: found };
  }

  if (decision.action === "edit") {
    const title =
      decision.confirmedByUser === true ? (decision.title ?? found.title) : found.title;
    const text =
      decision.confirmedByUser === true ? (decision.text ?? found.text) : found.text;
    const lint = lintText({
      title,
      text,
      kind: found.kind,
      scope: found.scope,
      maxChars:
        found.kind === "rule"
          ? config.thresholds.ruleMaxChars
          : config.thresholds.memoryMaxChars,
      titleMaxChars: config.thresholds.titleMaxChars,
    });
    const decisionResult = found.decision ?? {
      kind: found.kind,
      duplicate: 0,
      safeAuto: 0.5,
      risk: 0.7,
      confidence: 0.5,
      strictness: "unknown" as const,
      reasons: ["no decision result"],
      source: "heuristic" as const,
    };
    const { priority, breakdown } = computePriority(
      decisionResult,
      found.createdAt,
      found.scope,
    );
    const next: QueueItem = {
      ...found,
      title,
      text,
      priority,
      priorityBreakdown: breakdown,
      reason: lint.ok ? found.reason : `linter: ${lint.errors.join("; ")}`,
      diff: `+ ${text}`,
      suggestion: undefined,
      suggestionState: undefined,
      suggestionError: undefined,
      updatedAt: new Date().toISOString(),
    };
    await store.upsertQueue(next);
    await store.appendChangelog({ action: "edit", queueID: found.id, note: decision.note, source });
    return { ok: true, item: next };
  }

  const deferredUntil = decision.action === "resume" ? undefined : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const next: QueueItem = {
    ...found,
    deferredUntil,
    updatedAt: new Date().toISOString(),
  };
  await store.upsertQueue(next);
  await store.appendChangelog({
    action: decision.action === "resume" ? "resume" : "defer",
    queueID: found.id,
    deferredUntil,
    note: decision.note,
    source,
  });
  const persisted = (await store.listQueue()).find((item) => item.id === found.id);
  if (!persisted) {
    return {
      ok: false,
      error: "延后操作后无法重新读取条目，已回滚",
    };
  }
  return {
    ok: true,
    item: persisted,
    decisionVersion: queueItemSnapshotVersion(persisted),
  };
}
