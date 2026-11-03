import { Store, newId } from "./store.js";
import type { AutoMemConfig, Item, QueueItem } from "./types.js";
import { lintText } from "./linter.js";
import { computePriority } from "./priority.js";
import { admitNewItem } from "./capacity.js";
import { applySuggestion } from "./apply.js";
import { rebuildAutoFiles } from "./rebuild.js";

export type QueueAction = "approve" | "deny" | "edit" | "defer" | "apply_suggestion";

export interface QueueDecision {
  action: QueueAction;
  text?: string;
  title?: string;
  note?: string;
}

export interface QueueActionResult {
  ok: boolean;
  error?: string;
  item?: QueueItem;
  target?: string;
  journalID?: string;
}

export async function applyQueueDecision(
  store: Store,
  config: AutoMemConfig,
  id: string,
  decision: QueueDecision,
): Promise<QueueActionResult> {
  if (decision.action === "apply_suggestion") {
    const result = await applySuggestion(store, config, id, {
      title: decision.title,
      text: decision.text,
      note: decision.note,
    });
    if (!result.ok) return { ok: false, error: result.error };
    const queue = await store.listQueue();
    return {
      ok: true,
      item: queue.find((item) => item.id === id),
      target: result.target?.id ?? result.item?.id,
      journalID: result.journalID,
    };
  }

  const queue = await store.listQueue();
  const found = queue.find((item) => item.id === id);
  if (!found) return { ok: false, error: "queue item not found" };

  if (decision.action === "approve") {
    if (found.kind === "skill") {
      return { ok: false, error: "skill candidates need a draft; use the Skill Review flow" };
    }
    const admission = await admitNewItem(store, config, found.kind);
    if (!admission.ok) return { ok: false, error: admission.reason ?? "容量不足" };

    const title = decision.title ?? found.title;
    const text = decision.text ?? found.text;
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
      status: "auto",
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
    await store.appendItem(item);
    await store.removeQueue(found.id);
    await rebuildAutoFiles(store);
    await store.incrementStat("suggestionApplied");
    await store.appendChangelog({
      action: "approve",
      queueID: found.id,
      itemID: item.id,
      target,
      note: decision.note,
    });
    return { ok: true, item: found, target };
  }

  if (decision.action === "deny") {
    await store.removeQueue(found.id);
    const now = new Date().toISOString();
    const item: Item = {
      id: newId("item"),
      title: found.title,
      text: found.text,
      kind: found.kind,
      scope: found.scope,
      project: found.project,
      status: "archived",
      source: found.source,
      createdAt: now,
      updatedAt: now,
      decision: found.decision,
      tags: [...(found.tags ?? []), found.id],
    };
    await store.appendItem(item);
    await store.incrementStat("suggestionRejected");
    await store.appendChangelog({
      action: "deny",
      queueID: found.id,
      itemID: item.id,
      note: decision.note,
    });
    return { ok: true, item: found };
  }

  if (decision.action === "edit") {
    const title = decision.title ?? found.title;
    const text = decision.text ?? found.text;
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

  const deferredUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const next: QueueItem = {
    ...found,
    deferredUntil,
    updatedAt: new Date().toISOString(),
  };
  await store.upsertQueue(next);
  await store.appendChangelog({
    action: "defer",
    queueID: found.id,
    deferredUntil,
    note: decision.note,
  });
  return { ok: true, item: next };
}
