import type {
  AutoMemConfig,
  Item,
  MergeAction,
  MergeJournal,
  QueueItem,
} from "./types.js";
import { newId, type Store } from "./store.js";
import { compact, lintText } from "./linter.js";
import { admitNewItem } from "./capacity.js";
import { rebuildAutoFiles } from "./rebuild.js";

export interface ApplyEdits {
  title?: string;
  text?: string;
  note?: string;
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  action?: MergeAction;
  journalID?: string;
  target?: Item;
  item?: Item;
}

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function applySuggestion(
  store: Store,
  config: AutoMemConfig,
  queueID: string,
  edits?: ApplyEdits,
): Promise<ApplyResult> {
  const queue = await store.listQueue();
  const item = queue.find((entry) => entry.id === queueID);
  if (!item) return { ok: false, error: "队列条目不存在" };
  const suggestion = item.suggestion;
  if (!suggestion) return { ok: false, error: "还没有合并建议，请先生成" };
  if (item.kind === "skill") {
    return { ok: false, error: "skill 需要走 Skill Review 的 draft 流程" };
  }

  const title = compact(edits?.title ?? suggestion.proposedTitle);
  const text = compact(edits?.text ?? suggestion.proposedText);
  const maxChars =
    item.kind === "rule" ? config.thresholds.ruleMaxChars : config.thresholds.memoryMaxChars;
  const lint = lintText({
    title,
    text,
    kind: item.kind,
    scope: item.scope,
    maxChars,
    titleMaxChars: config.thresholds.titleMaxChars,
  });
  if (!lint.ok) return { ok: false, error: `linter: ${lint.errors.join("; ")}` };

  const action = suggestion.action;
  const target = suggestion.targetId
    ? (await store.listItems()).find((entry) => entry.id === suggestion.targetId)
    : undefined;
  if ((action === "merge_into" || action === "replace") && !target) {
    return { ok: false, error: "合并目标已不存在，请重新生成建议" };
  }
  if ((action === "create" || action === "keep_both") && target?.id === item.id) {
    return { ok: false, error: "合并目标不能是候选自身" };
  }
  if (action === "create" || action === "keep_both") {
    const admission = await admitNewItem(store, config, item.kind);
    if (!admission.ok) return { ok: false, error: admission.reason ?? "容量不足" };
  }

  const journal: MergeJournal = {
    id: newId("merge"),
    at: new Date().toISOString(),
    action,
    queueID: item.id,
    targetID: target?.id,
    before: { target, queue: item },
    after: {},
  };
  await store.appendJournal(journal);

  const now = new Date().toISOString();
  let created: Item | undefined;
  let updatedTarget: Item | undefined;

  if (action === "merge_into" || action === "replace") {
    if (!target) return { ok: false, error: "合并目标已不存在" };
    if (action === "replace") {
      await store.appendItem({
        ...target,
        id: newId("item"),
        status: "archived",
        supersededBy: target.id,
        tags: [...(target.tags ?? []), `merge:${journal.id}`],
        createdAt: now,
        updatedAt: now,
      });
    }
    updatedTarget = await store.updateItem(target.id, {
      title,
      text,
      status: target.status === "promoted" ? "promoted" : "auto",
      seenCount: (target.seenCount ?? 1) + 1,
      lastSeenAt: now,
      sources: [...(target.sources ?? [target.source]), item.source].slice(-20),
      aliases: [...(target.aliases ?? []), item.text].slice(-10),
    });
    if (!updatedTarget) return { ok: false, error: "更新目标失败" };
  } else if (action === "reject_duplicate") {
    created = {
      id: newId("item"),
      title: item.title,
      text: item.text,
      kind: item.kind,
      scope: item.scope,
      project: item.project,
      status: "archived",
      source: item.source,
      createdAt: now,
      updatedAt: now,
      decision: item.decision,
      priority: item.priority,
      priorityBreakdown: item.priorityBreakdown,
      sources: [item.source],
      seenCount: 1,
      lastSeenAt: now,
      tags: [...(item.tags ?? []), item.id, `merge:${journal.id}`],
    };
    await store.appendItem(created);
    if (target) updatedTarget = await store.touchItem(target.id, item.source);
  } else {
    created = {
      id: newId("item"),
      title,
      text,
      kind: item.kind,
      scope: item.scope,
      project: item.project,
      status: "auto",
      source: item.source,
      createdAt: now,
      updatedAt: now,
      decision: item.decision,
      priority: item.priority,
      priorityBreakdown: item.priorityBreakdown,
      sources: [item.source],
      seenCount: 1,
      lastSeenAt: now,
      tags: [...(item.tags ?? []), item.id, `merge:${journal.id}`],
    };
    await store.appendItem(created);
  }

  await store.removeQueue(item.id);
  await store.updateJournal(journal.id, {
    after: { itemID: created?.id, targetText: updatedTarget?.text },
  });
  await store.incrementStat(
    action === "reject_duplicate" ? "suggestionRejected" : "suggestionApplied",
  );
  await store.appendChangelog({
    action: `apply_${action}`,
    queueID: item.id,
    targetID: target?.id,
    journalID: journal.id,
    note: edits?.note,
  });
  await rebuildAutoFiles(store);
  return {
    ok: true,
    action,
    journalID: journal.id,
    target: updatedTarget,
    item: created,
  };
}

export async function undoMerge(
  store: Store,
  journalID: string,
): Promise<ApplyResult> {
  const entries = await store.listJournal();
  const entry = entries.find((candidate) => candidate.id === journalID);
  if (!entry) return { ok: false, error: "撤销记录不存在" };
  if (entry.undone) return { ok: false, error: "这次合并已经撤销过" };
  if (Date.now() - new Date(entry.at).getTime() > UNDO_WINDOW_MS) {
    return { ok: false, error: "超过 24 小时撤销窗口" };
  }

  if (entry.before.target) {
    const before = entry.before.target;
    await store.updateItem(before.id, {
      title: before.title,
      text: before.text,
      status: before.status,
      seenCount: before.seenCount,
      lastSeenAt: before.lastSeenAt,
      sources: before.sources,
      aliases: before.aliases,
      supersededBy: before.supersededBy,
    });
  }

  const items = await store.listItems();
  for (const item of items) {
    if (
      item.tags?.includes(`merge:${entry.id}`) &&
      item.status !== "archived" &&
      item.id !== entry.before.target?.id
    ) {
      await store.updateItem(item.id, { status: "archived", supersededBy: "undo" });
    }
  }

  await store.upsertQueue({
    ...entry.before.queue,
    suggestionState: entry.before.queue.suggestion ? "ready" : undefined,
  });
  await store.markJournalUndone(entry.id);
  await store.incrementStat("mergeUndone");
  await store.appendChangelog({ action: "undo_merge", journalID: entry.id, queueID: entry.queueID });
  await rebuildAutoFiles(store);
  return { ok: true, action: entry.action, journalID: entry.id };
}

export function applyResultOf(item: QueueItem): string {
  return item.suggestion?.action ?? "create";
}
