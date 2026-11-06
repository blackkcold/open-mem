import type {
  AutoMemConfig,
  DecisionResult,
  Item,
  QueueItem,
  Suggestion,
} from "./types.js";
import type { Store } from "./store.js";
import { newId } from "./store.js";
import { compact, lintText } from "./linter.js";
import { itemContentVersion } from "./fingerprint.js";
import { composeRewrite } from "./rewrite/composer.js";
import { validateRewrite } from "./rewrite/validate.js";
import type { RewriteService } from "./rewrite/index.js";
import type { RewriteInput } from "./rewrite/types.js";

export interface SuggestionDeps {
  store: Store;
  config: AutoMemConfig;
  rewrite?: RewriteService;
  broadcast?: (event: string, data: unknown) => void;
}

export async function buildSuggestion(
  deps: SuggestionDeps,
  queueItem: QueueItem,
  decision: DecisionResult,
  target?: Item,
): Promise<Suggestion> {
  const maxChars = maxCharsFor(deps.config, queueItem.kind);
  const titleMaxChars = deps.config.thresholds.titleMaxChars;
  const usableTarget =
    target && (target.status === "auto" || target.status === "promoted") &&
    target.kind === queueItem.kind &&
    target.scope === queueItem.scope &&
    (queueItem.scope !== "project" ||
      (queueItem.projectKey !== undefined && target.projectKey === queueItem.projectKey))
      ? target : undefined;
  const requested = decision.mergeAction ?? "create";

  let suggestion: Suggestion;

  if ((requested === "merge_into" || requested === "replace") && usableTarget) {
    const input: RewriteInput = {
      candidate: {
        id: queueItem.id,
        title: queueItem.title,
        text: queueItem.text,
        kind: queueItem.kind,
        scope: queueItem.scope,
      },
      target: {
        id: usableTarget.id,
        title: usableTarget.title,
        text: usableTarget.text,
        kind: usableTarget.kind,
        scope: usableTarget.scope,
      },
      action: requested,
      maxChars,
      titleMaxChars,
      conflict: decision.conflict ?? 0,
    };
    const output = deps.rewrite
      ? await deps.rewrite.suggest(input)
      : composeRewrite(input);
    const validation = validateRewrite(input, output);
    const keepBoth = output.action === "keep_both";
    const finalAction = keepBoth ? "keep_both" : requested;
    // "Keep both" creates a second row for the candidate. The rewrite output
    // is the target (or a merged text), so using it here would duplicate the
    // target and silently drop the candidate.
    const keepBothLint = keepBoth
      ? lintText({
          title: queueItem.title,
          text: queueItem.text,
          kind: queueItem.kind,
          scope: queueItem.scope,
          maxChars,
          titleMaxChars,
        })
      : undefined;
    suggestion = {
      id: newId("sug"),
      queueID: queueItem.id,
      action: finalAction,
      targetId: usableTarget.id,
      targetTitle: usableTarget.title,
      targetVersion: itemContentVersion(usableTarget),
      proposedTitle: keepBoth ? queueItem.title : output.title,
      proposedText: keepBoth ? queueItem.text : output.text,
      preserved: keepBoth ? [queueItem.text] : output.preserved,
      dropped: keepBoth ? [] : output.dropped,
      rationale: keepBoth
        ? "两者相关但不能安全合并，建议保留两条。"
        : output.rationale,
      confidence: decision.confidence,
      source: keepBoth ? "composer" : output.source,
      model: keepBoth ? undefined : output.model,
      validation: keepBoth
        ? {
            ok: keepBothLint?.ok ?? false,
            errors: keepBothLint?.errors ?? ["保留两条需要有效的候选正文"],
            warnings: keepBothLint?.warnings ?? [],
          }
        : { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
      createdAt: new Date().toISOString(),
    };
  } else {
    const finalAction =
      requested === "reject_duplicate"
        ? "reject_duplicate"
        : requested === "keep_both"
          ? "keep_both"
          : "create";
    // Show the candidate that will be archived. The target remains visible
    // through targetId/targetTitle; editing this archived copy is disabled.
    const proposedText = queueItem.text;
    const lint = lintText({
      title: queueItem.title,
      text: proposedText,
      kind: queueItem.kind,
      scope: queueItem.scope,
      maxChars,
      titleMaxChars,
    });
    suggestion = {
      id: newId("sug"),
      queueID: queueItem.id,
      action: finalAction,
      targetId: usableTarget?.id,
      targetTitle: usableTarget?.title,
      targetVersion: usableTarget ? itemContentVersion(usableTarget) : undefined,
      proposedTitle: queueItem.title,
      proposedText,
      preserved: [proposedText],
      dropped: [],
      rationale:
        finalAction === "reject_duplicate"
          ? usableTarget
            ? "目标条目已经覆盖候选，建议拒绝重复。"
            : "判定为重复候选，建议归档。"
          : finalAction === "keep_both"
            ? "两者相关但不能安全合并，建议保留两条。"
            : "建议作为新条目写入。",
      confidence: decision.confidence,
      source: "composer",
      validation: { ok: lint.ok, errors: lint.errors, warnings: lint.warnings },
      createdAt: new Date().toISOString(),
    };
  }

  const ready = suggestion.validation.ok;
  await deps.store.patchQueue([{ id: queueItem.id, patch: {
    suggestion,
    suggestionState: ready ? "ready" : "failed",
    suggestionError: ready
      ? undefined
      : (suggestion.validation.errors.join("；") || "建议未通过校验"),
  } }]);
  deps.broadcast?.("suggestion.updated", suggestion);
  return suggestion;
}

export function maxCharsFor(config: AutoMemConfig, kind: Item["kind"]): number {
  return kind === "rule" ? config.thresholds.ruleMaxChars : config.thresholds.memoryMaxChars;
}

export function suggestionTarget(
  items: Item[],
  suggestion: Suggestion | undefined,
): Item | undefined {
  if (!suggestion?.targetId) return undefined;
  return items.find((item) => item.id === suggestion.targetId);
}

export function isSuggestionReady(item: QueueItem): boolean {
  return Boolean(
    item.suggestion &&
      item.suggestion.validation.ok &&
      item.suggestionState !== "pending" &&
      item.suggestionState !== "failed",
  );
}

export function compactSuggestionText(suggestion: Suggestion): string {
  return compact(suggestion.proposedText);
}
