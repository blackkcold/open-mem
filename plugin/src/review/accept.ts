import type {
  AutoMemConfig,
  HookRecord,
  ReviewRunResult,
  ReviewSessionNote,
} from "../types.js";
import type { Store } from "../store.js";
import { newId } from "../store.js";
import { compact } from "../linter.js";
import { normalizeForFingerprint, textSimilarity } from "../fingerprint.js";
import { sha16 } from "../util/text.js";
import type { ReviewInput } from "./input.js";

export interface AcceptReviewDeps {
  store: Store;
  config: AutoMemConfig;
  project?: string;
  projectKey?: string;
}

export interface AcceptReviewResult {
  created: number;
  skipped: number;
  sessionNotes: ReviewSessionNote[];
}

/**
 * Turns validated review candidates into HookRecords and lets the normal
 * consolidation pipeline own the rest. Nothing here writes to queue, items or
 * AUTO_* files; that keeps one writer and reuses hook-key plus similarity
 * dedupe instead of a separate claim ledger.
 */
export async function acceptReviewCandidates(
  input: ReviewInput,
  result: ReviewRunResult,
  reviewID: string,
  deps: AcceptReviewDeps,
): Promise<AcceptReviewResult> {
  if (result.candidates.length === 0) {
    return { created: 0, skipped: 0, sessionNotes: [] };
  }

  const [existing, queue, items] = await Promise.all([
    deps.store.listHooks(),
    deps.store.listQueue(),
    deps.store.listItems(),
  ]);
  const keys = new Set(existing.map((hook) => hook.key));
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
  const sessionNotes: ReviewSessionNote[] = [];

  for (const candidate of result.candidates) {
    const primary =
      candidate.evidence.find((evidence) => evidence.kind === "user") ?? candidate.evidence[0];
    if (!primary) {
      skipped += 1;
      continue;
    }

    const duplicate =
      corpus.some((item) =>
        item.scope === candidate.scope &&
        (candidate.scope !== "project" ||
          (deps.projectKey !== undefined && item.projectKey === deps.projectKey)) &&
        textSimilarity(item.text, candidate.text) >= 0.85,
      ) ||
      acceptedTexts.some((text) => textSimilarity(text, candidate.text) >= 0.85) ||
      sessionHooks.some((hook) => {
        const sameQuote =
          hook.evidence?.some(
            (evidence) =>
              evidence.kind === "user" && evidence.quote === primary.quote,
          ) ?? false;
        return sameQuote || textSimilarity(hook.text, candidate.text) >= 0.85;
      });
    if (duplicate) {
      skipped += 1;
      continue;
    }

    // Session-only candidates never become hooks or queue items. They are
    // persisted with the review record as session notes for resume/recall.
    if (candidate.scope === "session" || candidate.taskOnly) {
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
    if (keys.has(key)) {
      skipped += 1;
      continue;
    }

    const hook: HookRecord = {
      id: newId("hook"),
      key,
      sessionID: input.sessionID,
      turnID: `review:${reviewID}`,
      messageID: primary.messageID,
      text: candidate.text,
      title: compact(candidate.text).slice(0, 30),
      trigger: `review:${candidate.type}`,
      scope: candidate.scope,
      project: deps.project,
      projectKey: candidate.scope === "project" ? deps.projectKey : undefined,
      source: {
        sessionID: input.sessionID,
        messageID: primary.messageID,
        role: primary.kind === "user" ? "user" : "assistant",
        project: deps.project,
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
    await deps.store.appendHook(hook);
    keys.add(key);
    acceptedTexts.push(candidate.text);
    sessionHooks.push(hook);
    created += 1;
  }

  return { created, skipped, sessionNotes };
}
