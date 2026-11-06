import type { AutoMemConfig, Item, ReviewRecord } from "../types.js";
import type { Store } from "../store.js";
import { newId } from "../store.js";
import { compact, lintText } from "../linter.js";
import { admitNewItem } from "../capacity.js";
import { rebuildAutoFiles } from "../rebuild.js";
import { reviewKind } from "../review/decision.js";
import { canPromote } from "./promotion.js";
import type { RelationKind } from "../relations.js";
import type { WriteConflict } from "./write-guard.js";

export interface SessionPromotionDecision {
  targetScope: "project" | "global";
  projectKey?: string;
  confirmedByUser?: boolean;
  acknowledgedRelations?: Array<{
    id: string;
    relation: RelationKind;
    version: string;
  }>;
}

export interface SessionPromotionResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  code?: "RELATION_ACK_REQUIRED";
  conflicts?: WriteConflict[];
  item?: Item;
}

/**
 * Promote one session note out of a review record. The note stays in the
 * review history; the active item is the durable copy.
 */
export async function promoteSessionNote(
  store: Store,
  config: AutoMemConfig,
  reviewID: string,
  index: number,
  decision: SessionPromotionDecision,
): Promise<SessionPromotionResult> {
  const key = `session-note:${reviewID}:${index}`;
  const token = await store.claim(key, 60_000);
  if (!token) return { ok: false, error: "该笔记正在处理，请稍后刷新" };
  try { return await store.transaction(async () => await store.ownsClaim(key, token)
    ? promoteSessionNoteUnlocked(store, config, reviewID, index, decision)
    : { ok: false, error: "操作租约已失效，请刷新重试" }); }
  finally { await store.releaseReservation(key, token); }
}

async function promoteSessionNoteUnlocked(
  store: Store,
  config: AutoMemConfig,
  reviewID: string,
  index: number,
  decision: SessionPromotionDecision,
): Promise<SessionPromotionResult> {
  const reviews = await store.listReviews();
  const review = reviews.find((entry) => entry.id === reviewID) as
    | ReviewRecord
    | undefined;
  if (!review) return { ok: false, error: "review not found" };
  const note = review.sessionNotes?.[index];
  if (!note) return { ok: false, error: "session note not found" };
  if (note.status === "dismissed") return { ok: false, error: "笔记已忽略，请先恢复" };
  if (note.status === "promoted") return { ok: false, error: "这条笔记已保存到长期记忆" };

  const projectKey =
    decision.targetScope === "project"
      ? (decision.projectKey ?? review.projectKey)
      : undefined;
  if (decision.targetScope === "project" && decision.projectKey && decision.projectKey !== review.projectKey) {
    return { ok: false, error: "不能提升到其他项目" };
  }
  const kind = reviewKind(note.type);
  const title = compact(note.text).slice(0, config.thresholds.titleMaxChars);
  const lint = lintText({ title, text: note.text, kind, scope: decision.targetScope,
    maxChars: kind === "rule" ? config.thresholds.ruleMaxChars : config.thresholds.memoryMaxChars,
    titleMaxChars: config.thresholds.titleMaxChars });
  if (!lint.ok) return { ok: false, error: lint.errors.join("; ") };
  const admission = await admitNewItem(store, config, kind);
  if (!admission.ok) return { ok: false, error: admission.reason };
  const existing = (await store.listItems()).filter(
    (item) => item.status === "auto" || item.status === "promoted",
  );
  const queue = await store.listQueue();
  const gate = canPromote(
    {
      id: `review-note:${reviewID}:${index}`,
      title,
      text: note.text,
      kind: reviewKind(note.type),
      scope: "session",
      taskOnly: note.taskOnly,
      evidenceCount: note.evidence.length,
    },
    {
      target: decision.targetScope,
      confirmedByUser: decision.confirmedByUser === true,
      projectKey,
      existing,
      queue,
    },
  );
  let acknowledged: SessionPromotionDecision["acknowledgedRelations"];
  if (!gate.ok) {
    const conflicts = gate.conflicts ?? [];
    const unacknowledged = conflicts.filter(
      (conflict) =>
        conflict.relation === "conflict" &&
        !(decision.acknowledgedRelations ?? []).some(
          (entry) =>
            entry.id === conflict.id &&
            entry.relation === conflict.relation &&
            entry.version === conflict.version,
        ),
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
    acknowledged = decision.acknowledgedRelations?.filter((entry) =>
      conflicts.some(
        (conflict) =>
          conflict.id === entry.id &&
          conflict.relation === entry.relation &&
          conflict.version === entry.version,
      ),
    );
    const hardBlocks = conflicts.filter(
      (entry) =>
        entry.relation === "exact" ||
        entry.relation === "covered" ||
        entry.relation === "classification-mismatch",
    );
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
    if (conflicts.length === 0) {
      return { ok: false, error: gate.reason };
    }
  }

  const now = new Date().toISOString();
  const primary = note.evidence[0];
  const item: Item = {
    id: newId("item"),
    title,
    text: note.text,
    kind: reviewKind(note.type),
    scope: decision.targetScope,
    projectKey,
    status: "auto",
    manual: true,
    source: {
      sessionID: review.sessionID,
      messageID: primary?.messageID,
      role: primary?.kind === "tool" ? "assistant" : "user",
    },
    createdAt: now,
    updatedAt: now,
    evidence: note.evidence,
    seenCount: 1,
    lastSeenAt: now,
    sources: [
      {
        sessionID: review.sessionID,
        messageID: primary?.messageID,
        role: primary?.kind === "tool" ? "assistant" : "user",
      },
    ],
    tags: [`review:${reviewID}`, `note:${index}`],
  };
  await store.appendItem(item);
  await store.updateReviewNote(reviewID, index, { status: "promoted", promotedItemID: item.id });
  await rebuildAutoFiles(store);
  await store.incrementStat("promotionApplied");
  await store.appendChangelog({
    action: "promote_session_note",
    reviewID,
    noteIndex: index,
    itemID: item.id,
    target: decision.targetScope,
    projectKey,
    acknowledgedRelations:
      acknowledged && acknowledged.length > 0 ? acknowledged : undefined,
  });
  return { ok: true, item };
}
