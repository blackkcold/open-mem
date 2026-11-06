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
import { itemContentVersion } from "./fingerprint.js";
import { isSuggestionReady } from "./suggestion.js";
import { validateRewrite } from "./rewrite/validate.js";
import { findWriteConflicts } from "./memory/write-guard.js";
import type { RelationKind } from "./relations.js";
import type { RewriteInput, RewriteOutput } from "./rewrite/types.js";

export interface ApplyEdits {
  title?: string;
  text?: string;
  note?: string;
}

export interface RelationWarning {
  id: string;
  relation: RelationKind;
  version: string;
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
  action?: MergeAction;
  journalID?: string;
  target?: Item;
  item?: Item;
  /** Non-blocking relation evidence for create/keep_both; never copied bodies. */
  relationWarnings?: RelationWarning[];
}

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function applySuggestion(
  store: Store,
  config: AutoMemConfig,
  queueID: string,
  edits?: ApplyEdits,
): Promise<ApplyResult> {
  return store.transaction(() => applySuggestionUnlocked(store, config, queueID, edits));
}

async function applySuggestionUnlocked(
  store: Store,
  config: AutoMemConfig,
  queueID: string,
  edits?: ApplyEdits,
): Promise<ApplyResult> {
  const queue = await store.listQueue();
  const item = queue.find((entry) => entry.id === queueID);
  if (!item) return { ok: false, error: "队列条目不存在" };
  if (item.scope === "session") {
    return {
      ok: false,
      error: "session 条目只能通过 promote 提升到 project/global",
    };
  }
  const suggestion = item.suggestion;
  if (!suggestion) return { ok: false, error: "还没有合并建议，请先生成" };
  if (item.kind === "skill") {
    return { ok: false, error: "skill 需要走 Skill Review 的 draft 流程" };
  }

  const proposedTitle = compact(suggestion.proposedTitle);
  const proposedText = compact(suggestion.proposedText);
  const title = compact(edits?.title ?? suggestion.proposedTitle);
  const text = compact(edits?.text ?? suggestion.proposedText);
  const titleEdited = title !== proposedTitle;
  const textEdited = text !== proposedText;
  const humanEdited = titleEdited || textEdited;
  if (suggestion.action === "reject_duplicate" && humanEdited) {
    return {
      ok: false,
      error: "拒绝重复会归档候选原文，不能同时修改标题或正文；请改用保留两条或新建",
    };
  }

  // The UI disables apply for invalid suggestions, but the API must enforce
  // the same rule. Only a body edit is the human-validation lane: renaming a
  // title must not make an invalid merge body applicable. A body edit still
  // runs lint, target and scope checks below, but it does not pretend that the
  // model's validation passed.
  if (!textEdited && !isSuggestionReady(item)) {
    if (item.suggestionState === "pending") {
      return { ok: false, error: "合并建议正在生成，请等待完成或人工修改后再应用" };
    }
    if (item.suggestionState === "failed") {
      return { ok: false, error: "合并建议生成或校验失败，请重新生成或人工修改后再应用" };
    }
    return {
      ok: false,
      error: `合并建议未通过校验，请重新生成或人工修改后再应用：${suggestion.validation.errors.join("；") || "未知原因"}`,
    };
  }

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
  if ((action === "merge_into" || action === "replace") && (item.kind === "rule" || target?.kind === "rule")) {
    return { ok: false, error: "规则不能合并或替换，请保留独立规则供用户检查" };
  }
  if ((action === "merge_into" || action === "replace") && !target) {
    return { ok: false, error: "合并目标已不存在，请重新生成建议" };
  }
  if (target && ["merge_into", "replace", "reject_duplicate"].includes(action) &&
      (!suggestion.targetVersion || suggestion.targetVersion !== itemContentVersion(target))) {
    return { ok: false, error: "目标内容已变更或建议版本过旧，请重新生成建议" };
  }
  if (
    target && (action === "merge_into" || action === "replace" || action === "reject_duplicate") &&
    (target.scope !== item.scope ||
      (item.scope === "project" && (!item.projectKey || target.projectKey !== item.projectKey)))
  ) {
    return { ok: false, error: "目标不属于相同范围或项目，请重新生成建议" };
  }
  // Re-run the deterministic rewrite checks against the current target and
  // candidate. A suggestion generated before this guard (or before the target
  // changed) must not bypass validation just because its stored flag says ok.
  if (!textEdited && (action === "merge_into" || action === "replace")) {
    if (!target) return { ok: false, error: "合并目标已不存在，请重新生成建议" };
    const rewriteInput: RewriteInput = {
      candidate: {
        id: item.id,
        title: item.title,
        text: item.text,
        kind: item.kind,
        scope: item.scope,
      },
      target: {
        id: target.id,
        title: target.title,
        text: target.text,
        kind: target.kind,
        scope: target.scope,
      },
      action,
      maxChars,
      titleMaxChars: config.thresholds.titleMaxChars,
      conflict: item.decision?.conflict ?? 0,
    };
    const rewriteOutput: RewriteOutput = {
      action: action === "replace" ? "replace" : "merge",
      title: suggestion.proposedTitle,
      text: suggestion.proposedText,
      preserved: suggestion.preserved,
      dropped: suggestion.dropped,
      rationale: suggestion.rationale,
      source: suggestion.source === "human" ? "composer" : suggestion.source,
      model: suggestion.model,
      latencyMs: 0,
    };
    const revalidation = validateRewrite(rewriteInput, rewriteOutput);
    if (!revalidation.ok) {
      return {
        ok: false,
        error: `建议写入前复核失败：${revalidation.errors.join("；")}`,
      };
    }
  }

  if ((action === "create" || action === "keep_both") && target?.id === item.id) {
    return { ok: false, error: "合并目标不能是候选自身" };
  }
  let relationWarnings: RelationWarning[] | undefined;
  if (action === "create" || action === "keep_both") {
    const guard = findWriteConflicts(
      {
        id: item.id,
        title,
        text,
        kind: item.kind,
        scope: item.scope,
        projectKey: item.projectKey,
      },
      [...(await store.listItems()), ...(await store.listQueue())],
      { excludeID: item.id },
    );
    const relevant = guard.conflicts.filter((entry) =>
      ["exact", "covered", "classification-mismatch", "conflict"].includes(
        entry.relation,
      ),
    );
    relationWarnings =
      relevant.length > 0
        ? relevant.map(({ id, relation, version }) => ({ id, relation, version }))
        : undefined;
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
    humanEdited: humanEdited || undefined,
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
      manual: true,
      seenCount: (target.seenCount ?? 1) + 1,
      lastSeenAt: now,
      sources: [...(target.sources ?? [target.source]), item.source].slice(-20),
      aliases: [...(target.aliases ?? []), item.text].slice(-10),
    }, target);
    if (!updatedTarget) return { ok: false, error: "更新目标失败" };
  } else if (action === "reject_duplicate") {
    created = {
      id: newId("item"),
      title: item.title,
      text: item.text,
      kind: item.kind,
      scope: item.scope,
      project: item.project,
      projectKey: item.projectKey,
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
      projectKey: item.projectKey,
      status: "auto",
      manual: true,
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
    after: { itemID: created?.id, targetText: updatedTarget?.text, target: updatedTarget, item: created },
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
    humanEdited: humanEdited || undefined,
    relationWarnings,
  });
  await rebuildAutoFiles(store);
  return {
    ok: true,
    action,
    journalID: journal.id,
    target: updatedTarget,
    item: created,
    relationWarnings,
  };
}

export async function undoMerge(
  store: Store,
  journalID: string,
): Promise<ApplyResult> {
  return store.transaction(() => undoMergeUnlocked(store, journalID));
}

async function undoMergeUnlocked(
  store: Store,
  journalID: string,
): Promise<ApplyResult> {
  let entry: MergeJournal;
  try { entry = await store.undoMergeEntry(journalID, UNDO_WINDOW_MS); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "撤销失败" }; }
  await store.incrementStat("mergeUndone");
  await store.appendChangelog({ action: "undo_merge", journalID: entry.id, queueID: entry.queueID });
  await rebuildAutoFiles(store);
  return { ok: true, action: entry.action, journalID: entry.id };
}

export function applyResultOf(item: QueueItem): string {
  return item.suggestion?.action ?? "create";
}
