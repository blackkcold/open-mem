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
    target && (target.status === "auto" || target.status === "promoted") ? target : undefined;
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
    const finalAction = output.action === "keep_both" ? "keep_both" : requested;
    suggestion = {
      id: newId("sug"),
      queueID: queueItem.id,
      action: finalAction,
      targetId: usableTarget.id,
      targetTitle: usableTarget.title,
      proposedTitle: output.title,
      proposedText: output.text,
      preserved: output.preserved,
      dropped: output.dropped,
      rationale: output.rationale,
      confidence: decision.confidence,
      source: output.source,
      model: output.model,
      validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
      createdAt: new Date().toISOString(),
    };
  } else {
    const finalAction =
      requested === "reject_duplicate" && usableTarget
        ? "reject_duplicate"
        : requested === "keep_both"
          ? "keep_both"
          : "create";
    const proposedText =
      finalAction === "reject_duplicate" && usableTarget
        ? usableTarget.text
        : queueItem.text;
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
      proposedTitle: queueItem.title,
      proposedText,
      preserved: [proposedText],
      dropped: [],
      rationale:
        finalAction === "reject_duplicate"
          ? "目标条目已经覆盖候选，建议拒绝重复。"
          : finalAction === "keep_both"
            ? "两者相关但不能安全合并，建议保留两条。"
            : "建议作为新条目写入。",
      confidence: decision.confidence,
      source: "composer",
      validation: { ok: lint.ok, errors: lint.errors, warnings: lint.warnings },
      createdAt: new Date().toISOString(),
    };
  }

  await deps.store.upsertQueue({
    ...queueItem,
    suggestion,
    suggestionState: "ready",
    suggestionError: undefined,
  });
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
      item.suggestionState !== "pending",
  );
}

export function compactSuggestionText(suggestion: Suggestion): string {
  return compact(suggestion.proposedText);
}
