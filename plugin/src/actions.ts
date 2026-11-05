import { Store, newId } from "./store.js";
import type { AutoMemConfig, Item, QueueItem } from "./types.js";
import { lintText } from "./linter.js";
import { computePriority } from "./priority.js";
import { admitNewItem } from "./capacity.js";
import { applySuggestion } from "./apply.js";
import { rebuildAutoFiles } from "./rebuild.js";
import { canPromote } from "./memory/promotion.js";

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
}

export interface QueueActionResult {
  ok: boolean;
  error?: string;
  item?: Item;
  target?: string;
  journalID?: string;
}

export async function applyQueueDecision(
  store: Store,
  config: AutoMemConfig,
  id: string,
  decision: QueueDecision,
): Promise<QueueActionResult> {
  const key = `queue-action:${id}`;
  const token = await store.claim(key, 60_000);
  if (!token) return { ok: false, error: "该条目正在处理，请稍后刷新" };
  try {
    return await store.transaction(async () => await store.ownsClaim(key, token)
      ? applyQueueDecisionUnlocked(store, config, id, decision)
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
): Promise<QueueActionResult> {
  const queue = await store.listQueue();
  const found = queue.find((item) => item.id === id);
  if (!found) return { ok: false, error: "queue item not found" };

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
      },
    );
    if (!gate.ok) return { ok: false, error: gate.reason };
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
    const nextQueue = await store.listQueue();
    return {
      ok: true,
      item: nextQueue.find((item) => item.id === id),
      target: result.target?.id ?? result.item?.id,
      journalID: result.journalID,
    };
  }

  if (decision.action === "approve") {
    if (found.kind === "skill") {
      return { ok: false, error: "skill candidates need a draft; use the Skill Review flow" };
    }
    const admission = await admitNewItem(store, config, found.kind);
    if (!admission.ok) return { ok: false, error: admission.reason ?? "容量不足" };

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
    await store.appendChangelog({
      action: "approve",
      recoveryID,
      queueID: found.id,
      itemID: item.id,
      target,
      note: decision.note,
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
    await store.appendChangelog({ action: "edit", queueID: found.id, note: decision.note });
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
  });
  return { ok: true, item: next };
}
