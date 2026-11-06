/**
 * Per-candidate editing drafts for the approval queue.
 *
 * A draft belongs to exactly one queue item id and remembers the version it
 * started from (item content plus suggestion id/content). When the server
 * version changes underneath it, the draft is kept and reported as a conflict
 * instead of being silently applied to the new version.
 */

export interface QueueDraftSuggestion {
  id: string;
  action?: string;
  targetId?: string;
  targetVersion?: string;
  proposedTitle: string;
  proposedText: string;
  createdAt?: string;
  confidence?: number;
  source?: string;
  validation?: unknown;
  rationale?: string;
  preserved?: string[];
  dropped?: unknown;
}

export interface QueueDraftSource {
  id: string;
  title: string;
  text: string;
  /** Full server-side decision version bound into the draft baseline. */
  decisionVersion?: string;
  kind?: string;
  scope?: string;
  projectKey?: string;
  origin?: string;
  status?: string;
  updatedAt?: string;
  priority?: number;
  priorityBreakdown?: unknown;
  reason?: string;
  suggestedAction?: string;
  deferredUntil?: string;
  decision?: unknown;
  /** @deprecated legacy assessment field, still bound to the snapshot. */
  jev?: unknown;
  suggestion?: QueueDraftSuggestion | null;
}

export interface QueueDraftBaseline {
  /** Server decision version the draft was captured against ("" if absent). */
  decisionVersion: string;
  itemUpdatedAt: string;
  itemTitle: string;
  itemText: string;
  /** Canonical snapshot of every non-suggestion field that affects a decision. */
  itemSnapshot: string;
  /** Canonical snapshot of the full suggestion the draft started from. */
  suggestionSnapshot: string | null;
  suggestionID: string | null;
  suggestionCreatedAt: string | null;
  suggestionTitle: string | null;
  suggestionText: string | null;
  note: string;
}

export interface QueueDraft {
  itemID: string;
  title: string;
  text: string;
  note: string;
  baseline: QueueDraftBaseline;
}

export type QueueDraftConflict =
  | "item-missing"
  | "item-mismatch"
  | "item-changed"
  | "suggestion-changed"
  | "version-missing"
  | "version-changed";

export type QueueDrafts = Readonly<Record<string, QueueDraft>>;

export function suggestedTitle(item: QueueDraftSource): string {
  return item.suggestion ? item.suggestion.proposedTitle : item.title;
}

export function suggestedText(item: QueueDraftSource): string {
  return item.suggestion ? item.suggestion.proposedText : item.text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable serialization so key order cannot hide a real change. */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const parts = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function itemSnapshotOf(item: QueueDraftSource): string {
  return stableSerialize({
    id: item.id,
    kind: item.kind ?? null,
    scope: item.scope ?? null,
    projectKey: item.projectKey ?? null,
    origin: item.origin ?? null,
    status: item.status ?? null,
    title: item.title,
    text: item.text,
    priority: item.priority ?? null,
    priorityBreakdown: item.priorityBreakdown ?? null,
    reason: item.reason ?? null,
    suggestedAction: item.suggestedAction ?? null,
    decision: item.decision ?? null,
    jev: item.jev ?? null,
  });
}

function suggestionSnapshotOf(
  suggestion: QueueDraftSuggestion | null | undefined,
): string | null {
  if (!suggestion) return null;
  return stableSerialize({
    id: suggestion.id,
    action: suggestion.action ?? null,
    targetId: suggestion.targetId ?? null,
    targetVersion: suggestion.targetVersion ?? null,
    proposedTitle: suggestion.proposedTitle,
    proposedText: suggestion.proposedText,
    createdAt: suggestion.createdAt ?? null,
    confidence: suggestion.confidence ?? null,
    source: suggestion.source ?? null,
    validation: suggestion.validation ?? null,
    rationale: suggestion.rationale ?? null,
    preserved: suggestion.preserved ?? null,
    dropped: suggestion.dropped ?? null,
  });
}

export function queueDraftBaseline(item: QueueDraftSource): QueueDraftBaseline {
  return {
    decisionVersion: item.decisionVersion ?? "",
    itemUpdatedAt: item.updatedAt ?? "",
    itemTitle: item.title,
    itemText: item.text,
    itemSnapshot: itemSnapshotOf(item),
    suggestionSnapshot: suggestionSnapshotOf(item.suggestion),
    suggestionID: item.suggestion ? item.suggestion.id : null,
    suggestionCreatedAt: item.suggestion?.createdAt ?? null,
    suggestionTitle: item.suggestion ? item.suggestion.proposedTitle : null,
    suggestionText: item.suggestion ? item.suggestion.proposedText : null,
    note: "",
  };
}

export function initialQueueDraft(item: QueueDraftSource): QueueDraft {
  return {
    itemID: item.id,
    title: suggestedTitle(item),
    text: suggestedText(item),
    note: "",
    baseline: queueDraftBaseline(item),
  };
}

function baselineTitle(draft: QueueDraft): string {
  return draft.baseline.suggestionID === null
    ? draft.baseline.itemTitle
    : (draft.baseline.suggestionTitle ?? "");
}

function baselineText(draft: QueueDraft): string {
  return draft.baseline.suggestionID === null
    ? draft.baseline.itemText
    : (draft.baseline.suggestionText ?? "");
}

export function isQueueDraftDirty(draft: QueueDraft): boolean {
  return (
    draft.title !== baselineTitle(draft) ||
    draft.text !== baselineText(draft) ||
    draft.note !== draft.baseline.note
  );
}

/**
 * Compare the version a draft started from with the current server version.
 * Any difference is a conflict: the draft must not be applied without an
 * explicit decision.
 */
export function queueDraftConflict(
  draft: QueueDraft,
  current: QueueDraftSource | null | undefined,
): QueueDraftConflict | null {
  if (!current) return "item-missing";
  if (
    !hasDecisionVersion(draft.baseline.decisionVersion) ||
    !hasDecisionVersion(current.decisionVersion)
  ) {
    return "version-missing";
  }
  if (draft.baseline.decisionVersion !== current.decisionVersion) {
    return "version-changed";
  }
  if (
    draft.baseline.suggestionSnapshot !==
    suggestionSnapshotOf(current.suggestion)
  ) {
    return "suggestion-changed";
  }
  // A draft is bound to one id: even an identical-looking twin is a conflict.
  if (draft.itemID !== current.id) return "item-mismatch";
  if (draft.baseline.itemSnapshot !== itemSnapshotOf(current)) {
    return "item-changed";
  }
  return null;
}

/**
 * Keep the user's edits but accept the current version as the new baseline.
 * Returns null for another queue id: a draft can never be rebound across ids.
 */
export function rebaselineQueueDraft(
  draft: QueueDraft,
  current: QueueDraftSource,
): QueueDraft | null {
  if (draft.itemID !== current.id) return null;
  if (!hasDecisionVersion(current.decisionVersion)) return null;
  return { ...draft, baseline: queueDraftBaseline(current) };
}

export function queueDraftFor(
  drafts: QueueDrafts,
  itemID: string | null | undefined,
): QueueDraft | undefined {
  if (!itemID) return undefined;
  return drafts[itemID];
}

/**
 * Store a draft only while it differs from its baseline. Collapsing a clean
 * draft back to "absent" keeps `hasDirtyQueueDrafts` honest.
 */
export function storeQueueDraft(drafts: QueueDrafts, draft: QueueDraft): QueueDrafts {
  const existing = drafts[draft.itemID];
  if (!isQueueDraftDirty(draft)) {
    if (!existing) return drafts;
    const next = { ...drafts };
    delete next[draft.itemID];
    return next;
  }
  if (existing === draft) return drafts;
  return { ...drafts, [draft.itemID]: draft };
}

export function discardQueueDraft(drafts: QueueDrafts, itemID: string): QueueDrafts {
  if (!drafts[itemID]) return drafts;
  const next = { ...drafts };
  delete next[itemID];
  return next;
}

export function hasDirtyQueueDrafts(drafts: QueueDrafts): boolean {
  return Object.keys(drafts).length > 0;
}

export function canSubmitQueueDraft(input: {
  busy: boolean;
  unavailable: boolean;
  conflict: QueueDraftConflict | null;
}): boolean {
  return !input.busy && !input.unavailable && input.conflict === null;
}

/**
 * Global pending total supplied by App's single /api/metrics snapshot.
 * Missing, failed or malformed data means unknown: never fall back to the
 * filtered page count and never display a stale number.
 */
export function globalQueueTotal(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function hasDecisionVersion(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface DecisionSnapshot {
  itemID: string;
  decisionVersion: string;
  suggestionID: string | null;
  title: string;
  text: string;
  note: string;
}

export function decisionSnapshotOf(
  item: {
    id: string;
    decisionVersion?: string;
    suggestion?: { id: string } | null;
  },
  values: { title: string; text: string; note: string },
): DecisionSnapshot {
  return {
    itemID: item.id,
    decisionVersion: item.decisionVersion ?? "",
    suggestionID: item.suggestion ? item.suggestion.id : null,
    title: values.title,
    text: values.text,
    note: values.note,
  };
}

/** True only when the dialog-shaped snapshot still matches the live form. */
export function sameDecisionSnapshot(
  left: DecisionSnapshot,
  right: DecisionSnapshot,
): boolean {
  return (
    left.itemID === right.itemID &&
    left.decisionVersion === right.decisionVersion &&
    left.suggestionID === right.suggestionID &&
    left.title === right.title &&
    left.text === right.text &&
    left.note === right.note
  );
}

/**
 * A successful approve/apply may drop the draft only when the exact submitted
 * content is still the current content of the same item. Deny/defer/resume do
 * not consume the edited content, and any typing during the save keeps it.
 */
export function shouldClearConsumedDraft(input: {
  action: string;
  itemID: string;
  draft: QueueDraft | undefined;
  submitted: { title: string; text: string; note: string };
  current: { title: string; text: string; note: string };
}): boolean {
  const { draft, submitted, current } = input;
  if (!draft) return false;
  if (input.action !== "approve" && input.action !== "apply_suggestion") {
    return false;
  }
  if (draft.itemID !== input.itemID) return false;
  if (
    draft.title !== submitted.title ||
    draft.text !== submitted.text ||
    draft.note !== submitted.note
  ) {
    return false;
  }
  return (
    submitted.title === current.title &&
    submitted.text === current.text &&
    submitted.note === current.note
  );
}

export interface PendingDecisionCheck {
  itemID: string;
  action: string;
}

/** An unknown single-decision result locks only that item until verified. */
export function decisionLockedByUnknown(
  pending: PendingDecisionCheck | null | undefined,
  itemID: string | null | undefined,
): boolean {
  return Boolean(pending && itemID && pending.itemID === itemID);
}

export interface DeferRebaseExpectation {
  itemID: string;
  /** Version the draft was submitted from. */
  oldVersion: string;
  /** Server-reported version after its own defer/resume transaction. */
  newVersion: string;
  /** Exact draft object at submission; any edit or recreation breaks identity. */
  draft: QueueDraft;
}

export interface DeferResponseEvidence {
  draft: QueueDraft | undefined;
  itemID: string;
  /** Version the user saw and submitted. */
  oldVersion: string;
  /** Version the draft baseline is actually bound to. */
  draftVersion: string | undefined;
  responseItemID: string | undefined;
  /** Top-level server version computed from the persisted row. */
  responseVersion: string | undefined;
}

/**
 * Accept a defer/resume response as rebase evidence only when all of its
 * independent fields prove the same transaction: the returned row is this
 * item, its version equals the flat response version, and the draft still
 * holds the exact submitted version.
 */
export function deferRebaseExpectation(
  input: DeferResponseEvidence,
): DeferRebaseExpectation | null {
  const { draft } = input;
  if (!draft) return null;
  if (draft.itemID !== input.itemID) return null;
  if (!hasDecisionVersion(input.oldVersion)) return null;
  if (!hasDecisionVersion(input.draftVersion)) return null;
  if (input.draftVersion !== input.oldVersion) return null;
  if (draft.baseline.decisionVersion !== input.draftVersion) return null;
  if (input.responseItemID !== input.itemID) return null;
  // The persisted item row does not carry decisionVersion; the top-level
  // version is the transaction proof.
  if (!hasDecisionVersion(input.responseVersion)) return null;
  if (input.responseVersion === input.oldVersion) return null;
  return {
    itemID: input.itemID,
    oldVersion: input.oldVersion,
    newVersion: input.responseVersion,
    draft,
  };
}

export type DeferRebaseOutcome =
  | { action: "wait" }
  | { action: "none" }
  | { action: "rebase"; draft: QueueDraft }
  | { action: "conflict"; reason: "draft-changed" | "version-unproven" };

/**
 * Only our own defer/resume may auto-rebaseline a draft, and only when the
 * reloaded item proves exactly the version the server returned inside its
 * transaction. Anything else stays a conflict for the user to confirm.
 */
export function resolveDeferRebase(input: {
  expectation: DeferRebaseExpectation;
  draft: QueueDraft | undefined;
  current: QueueDraftSource | null | undefined;
}): DeferRebaseOutcome {
  const { expectation, draft, current } = input;
  if (
    !hasDecisionVersion(expectation.oldVersion) ||
    !hasDecisionVersion(expectation.newVersion)
  ) {
    return { action: "conflict", reason: "version-unproven" };
  }
  if (!draft) return { action: "none" };
  if (draft.itemID !== expectation.itemID) {
    return { action: "conflict", reason: "version-unproven" };
  }
  if (draft.baseline.decisionVersion !== expectation.oldVersion) {
    return { action: "conflict", reason: "version-unproven" };
  }
  if (draft !== expectation.draft) {
    return { action: "conflict", reason: "draft-changed" };
  }
  if (!current) return { action: "wait" };
  if (current.id !== expectation.itemID) {
    return { action: "conflict", reason: "version-unproven" };
  }
  if (!hasDecisionVersion(current.decisionVersion)) {
    return { action: "conflict", reason: "version-unproven" };
  }
  if (current.decisionVersion === expectation.oldVersion) {
    return { action: "wait" };
  }
  if (current.decisionVersion !== expectation.newVersion) {
    return { action: "conflict", reason: "version-unproven" };
  }
  return { action: "rebase", draft: { ...draft, baseline: queueDraftBaseline(current) } };
}
