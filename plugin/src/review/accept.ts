import type {
  AutoMemConfig,
  HookRecord,
  ItemKind,
  ReviewRunResult,
  ReviewSessionNote,
  Scope,
} from "../types.js";
import type { Store } from "../store.js";
import { newId } from "../store.js";
import { compact } from "../linter.js";
import { normalizeForFingerprint } from "../fingerprint.js";
import { classifyRelation } from "../relations.js";
import { sha16 } from "../util/text.js";
import type { ReviewInput } from "./input.js";
import { reviewKind } from "./decision.js";

export interface AcceptReviewDeps {
  store: Store;
  config: AutoMemConfig;
  project?: string;
  /** Authoritative project key from the review record/session owner. */
  projectKey?: string;
  /** Current instance key; only used to reject a mismatched review. */
  instanceProjectKey?: string;
}

export interface AcceptReviewResult {
  created: number;
  skipped: number;
  /** Preserved candidates whose normalized key collided with different text. */
  conflicts: number;
  sessionNotes: ReviewSessionNote[];
}

/**
 * Turns validated review candidates into HookRecords and lets the normal
 * consolidation pipeline own the rest. Nothing here writes to queue, items or
 * AUTO_* files; that keeps one writer and reuses hook-key plus similarity
 * dedupe instead of a separate claim ledger.
 */
function sessionIDOf(entry: {
  source?: { sessionID?: string };
  sources?: Array<{ sessionID?: string }>;
}): string | undefined {
  if (entry.source?.sessionID) return entry.source.sessionID;
  return entry.sources?.find((source) => source.sessionID)?.sessionID;
}

export async function acceptReviewCandidates(
  input: ReviewInput,
  result: ReviewRunResult,
  reviewID: string,
  deps: AcceptReviewDeps,
): Promise<AcceptReviewResult> {
  if (result.candidates.length === 0) {
    return { created: 0, skipped: 0, conflicts: 0, sessionNotes: [] };
  }
  if (
    deps.projectKey !== undefined &&
    deps.instanceProjectKey !== undefined &&
    deps.projectKey !== deps.instanceProjectKey
  ) {
    return {
      created: 0,
      skipped: result.candidates.length,
      conflicts: 0,
      sessionNotes: [],
    };
  }

  const [existing, queue, items] = await Promise.all([
    deps.store.listHooks(),
    deps.store.listQueue(),
    deps.store.listItems(),
  ]);
  const sessionHooks = existing.filter(
    (hook) => hook.sessionID === input.sessionID,
  );
  // Dedupe against every lane, including ignored/failed hooks and already
  // queued or promoted items; otherwise a turn capture and a review capture of
  // the same sentence both reach the queue under different scopes.
  const corpus = [
    ...queue,
    ...items
      .filter((item) => item.status !== "archived")
      .slice(-200),
  ];
  const acceptedTexts: string[] = [];
  const now = new Date().toISOString();
  let created = 0;
  let skipped = 0;
  let conflicts = 0;
  const sessionNotes: ReviewSessionNote[] = [];
  const pending: Array<{ hook: HookRecord; candidate: (typeof result.candidates)[number] }> = [];

  for (const candidate of result.candidates) {
    const primary =
      candidate.evidence.find((evidence) => evidence.kind === "user") ?? candidate.evidence[0];
    if (!primary) {
      skipped += 1;
      continue;
    }

    const candidateKind = reviewKind(candidate.type);
    // A project hook without a projectKey is orphaned and silently dropped by
    // consolidation. Keep the text as a session note instead.
    const effectiveScope: Scope =
      candidate.scope === "project" && deps.projectKey === undefined
        ? "session"
        : candidate.scope;
    const isReviewDuplicate = (text: string, kind?: ItemKind): boolean => {
      const relation = classifyRelation(
        { text: candidate.text, kind: candidateKind },
        { text, kind },
      );
      // Only a true duplicate may be skipped. High lexical overlap with an
      // added clause or a replaced word must reach the queue for review.
      return relation.sameKind &&
        (relation.relation === "exact" || relation.relation === "covered");
    };
    const duplicate =
      corpus.some((item) =>
        item.scope === effectiveScope &&
        (effectiveScope !== "project" ||
          (deps.projectKey !== undefined && item.projectKey === deps.projectKey)) &&
        (effectiveScope !== "session" ||
          sessionIDOf(item) === input.sessionID) &&
        isReviewDuplicate(item.text, item.kind),
      ) ||
      acceptedTexts.some((text) => isReviewDuplicate(text)) ||
      sessionHooks.some((hook) => {
        const sameQuote =
          hook.evidence?.some(
            (evidence) =>
              evidence.kind === "user" && evidence.quote === primary.quote,
          ) ?? false;
        return sameQuote || isReviewDuplicate(
          hook.text,
          hook.reviewType ? reviewKind(hook.reviewType) : undefined,
        );
      });
    if (duplicate) {
      skipped += 1;
      continue;
    }

    // Session-only candidates never become hooks or queue items. They are
    // persisted with the review record as session notes for resume/recall.
    if (effectiveScope === "session" || candidate.taskOnly) {
      sessionNotes.push({
        type: candidate.type,
        text: candidate.text,
        evidence: candidate.evidence,
        ...(candidate.taskOnly ? { taskOnly: true } : {}),
        createdAt: now,
      });
      acceptedTexts.push(candidate.text);
      continue;
    }

    const key = `review|${input.sessionID}|${primary.messageID}|${sha16(
      normalizeForFingerprint(candidate.text),
    )}`;

    const hook: HookRecord = {
      id: newId("hook"),
      key,
      sessionID: input.sessionID,
      turnID: `review:${reviewID}`,
      messageID: primary.messageID,
      text: candidate.text,
      title: compact(candidate.text).slice(0, 30),
      trigger: `review:${candidate.type}`,
      scope: effectiveScope,
      project: deps.project,
      projectKey: effectiveScope === "project" ? deps.projectKey : undefined,
      source: {
        sessionID: input.sessionID,
        messageID: primary.messageID,
        role: primary.kind === "user" ? "user" : "assistant",
        project: deps.project,
        ...(Number.isFinite(input.sources[primary.messageID]?.userObservedAt)
          ? { observedAt: input.sources[primary.messageID]?.userObservedAt }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
      status: "pending",
      attempts: 0,
      origin: "session-review",
      reviewType: candidate.type,
      reviewID,
      evidence: candidate.evidence,
      reviewConfidence: candidate.confidence,
    };
    pending.push({ hook, candidate });
    acceptedTexts.push(candidate.text);
    sessionHooks.push(hook);
  }

  // Check-and-append inside one Store transaction: the cross-process file lock
  // closes the list/append race. A normalized-key collision with different text
  // is preserved as a session note instead of being silently dropped.
  await deps.store.transaction(async () => {
    const hooks = await deps.store.listHooks();
    const byKey = new Map(hooks.map((hook) => [hook.key, hook]));
    for (const { hook, candidate } of pending) {
      const existing = byKey.get(hook.key);
      if (existing) {
        if (existing.text === hook.text) {
          skipped += 1;
          continue;
        }
        conflicts += 1;
        sessionNotes.push({
          type: candidate.type,
          text: candidate.text,
          evidence: candidate.evidence,
          createdAt: now,
        });
        continue;
      }
      await deps.store.appendHook(hook);
      byKey.set(hook.key, hook);
      created += 1;
    }
  });

  return { created, skipped, conflicts, sessionNotes };
}
