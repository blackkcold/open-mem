import type { AutoMemConfig, EvidenceRef, Item, ReviewEvidence, SessionMessage, ShadowRecord, SourceRef } from "../types.js";
import type { Store } from "../store.js";
import { newId } from "../store.js";
import { newChangeID, recordChange } from "../changes.js";
import { itemContentVersion } from "../fingerprint.js";
import { classifyRelation } from "../relations.js";
import { hookKeysFor, suppressionTextHash } from "../memory/suppression.js";
import { compact, lintText } from "../linter.js";
import { rebuildAutoFiles } from "../rebuild.js";
import { sha16 } from "../util/text.js";
import { digestToolPart, projectToolFailure } from "../digest/tool.js";
import {
  expireLifecycleRecordsInTransaction,
  holdExtractQuarantine,
  isSourceRetired,
  promoteGlobalCandidate,
  sourceEpoch,
} from "../memory/lifecycle.js";
import type { SessionReader } from "../session/reader.js";
import { nativeToolMessageRole } from "../session/filters.js";
import { admitAutoWrite } from "../capacity.js";
import {
  admitExtractProposal,
  admitToolLearning,
  extractClaimKey,
  parseExtractClaim,
  type ExtractAdmission,
  type ParsedExtractClaim,
} from "./admission.js";
import {
  collectFailedToolEvidence,
  collectUserEvidence,
  locateUniqueQuote,
  type EvidenceBundle,
  type EvidenceSpan,
  type ToolEvidenceSpan,
} from "./evidence.js";
import type { ExtractProvider } from "./provider.js";

export interface ToolEvidenceKey {
  messageID: string;
  digestHash: string;
}

export interface ExtractCaptureOptions {
  /** Review-origin learning may include verified native failing tool parts. */
  includeFailedTools?: boolean;
  /** Tool digests that the review run actually saw; never an open transcript scan. */
  toolEvidence?: ToolEvidenceKey[];
  digestMaxChars?: number;
  /** Body budget for a complete failure projection (defaults to memoryMaxChars). */
  learningMaxChars?: number;
}

export interface ExtractEvidenceCapture {
  evidence: EvidenceBundle;
  spans: EvidenceSpan[];
  /** Failing tool parts rejected before the model call (role/synthetic/no diagnostic). */
  learningRejected?: string[];
}

export interface ExtractCreateDeps {
  store: Store;
  config: AutoMemConfig;
  reader: Pick<SessionReader, "readForEvidence">;
  provider: ExtractProvider;
  project?: string;
  projectKey?: string;
  /** Trusted identity resolved from this plugin instance's own git common-dir. */
  repoIdentity?: string;
  /** Protected review evidence is routed to the existing hook queue, never extract auto-write. */
  excludeEvidence?: ReviewEvidence[];
  /** Review-origin ordinary evidence: verified failing tool parts from the review window. */
  includeFailedTools?: boolean;
  toolEvidence?: ToolEvidenceKey[];
  /** Shared full-transcript capture, so retry identity and extraction use one read. */
  capture?: ExtractEvidenceCapture;
  /** Trusted plugin callback; extraction never derives native ownership itself. */
  ownsNativeRoot: (sessionID: string) => Promise<boolean>;
  log?: (message: string, error?: unknown) => void;
}

export interface ExtractCreateResult {
  created: number;
  skipped: number;
  updated?: number;
  /** Would-write records appended in shadow mode; never active items. */
  shadowed?: number;
  /** Failing-tool learning candidates skipped for a visible local reason. */
  learningSkipped?: number;
  reason?: string;
  /** Deferred work must remain recoverable; it is not a successful empty review. */
  deferred?: true;
  retryAt?: number;
  requestsMade?: number;
}

interface FrozenTarget {
  item: Item;
  version: string;
  recordHash: string;
}

interface FrozenTargetSet {
  targets: FrozenTarget[];
  overflow: boolean;
  hash: string;
}

interface ExtractCandidate {
  admission: ExtractAdmission & { ok: true };
  claim?: ParsedExtractClaim;
  evidenceRef: EvidenceRef;
  origin: "turn" | "session-review";
  span: EvidenceSpan;
  sourceEpoch: string;
  frozenTargets: FrozenTargetSet;
  reviewType?: "learning";
}

const spanKey = (span: EvidenceSpan): string =>
  `${span.messageID}\u0000${span.start}\u0000${span.end}`;

const emptyTargetSet = (): FrozenTargetSet => ({
  targets: [],
  overflow: false,
  hash: sha16("[]"),
});

function normalizeClaimPart(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function claimsForItem(item: Item): ParsedExtractClaim[] {
  const fromRefs = (item.evidenceRefs ?? []).flatMap((ref): ParsedExtractClaim[] => {
    if (!ref.claimKey || !ref.claimSubject || !ref.claimPredicate || !ref.claimValue) return [];
    return [{
      kind: item.kind,
      scope: item.scope,
      subject: ref.claimSubject,
      predicate: ref.claimPredicate,
      value: ref.claimValue,
      qualifiers: ref.claimQualifiers ?? [],
      polarity: ref.claimPolarity ?? "positive",
      intent: ref.claimIntent ?? "ordinary",
      ...(ref.claimOldValue ? { oldValue: ref.claimOldValue } : {}),
      explicitGlobal: ref.explicitGlobal === true,
      projectRelative: ref.claimProjectRelative === true,
    }];
  });
  if (fromRefs.length > 0) return fromRefs;
  const parsed = parseExtractClaim(item.text);
  return parsed ? [parsed] : [];
}

function sameClaimSubject(left: ParsedExtractClaim, right: ParsedExtractClaim): boolean {
  return left.kind === right.kind &&
    normalizeClaimPart(left.subject) === normalizeClaimPart(right.subject) &&
    normalizeClaimPart(left.predicate) === normalizeClaimPart(right.predicate);
}

function activeForRelation(item: Item, now: number): boolean {
  if ((item.status !== "auto" && item.status !== "promoted") || item.invalidatedBy) return false;
  if (!item.expiresAt) return true;
  const expiresAt = Date.parse(item.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt > now;
}

function freezeRelationTargets(
  items: Item[],
  claim: ParsedExtractClaim,
  candidateText: string,
  projectKey: string | undefined,
  now: number,
): FrozenTargetSet {
  const matched = items
    .filter((item) => item.reviewType !== "learning" &&
      activeForRelation(item, now) &&
      item.scope === claim.scope &&
      (claim.scope !== "project" || projectKey !== undefined && item.projectKey === projectKey) &&
      (claimsForItem(item).some((existing) => sameClaimSubject(existing, claim)) ||
        classifyRelation(
          { text: candidateText, kind: claim.kind },
          { text: item.text, kind: item.kind },
        ).relation !== "unknown"))
    .sort((left, right) => left.id.localeCompare(right.id));
  const identities = matched.map((item) => ({
    id: item.id,
    version: itemContentVersion(item),
    recordHash: sha16(JSON.stringify(item)),
  }));
  return {
    targets: matched.slice(0, 8).map((item, index) => ({
      item: structuredClone(item),
      version: identities[index].version,
      recordHash: identities[index].recordHash,
    })),
    overflow: matched.length > 8,
    hash: sha16(JSON.stringify(identities)),
  };
}

function uniqueEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.sourceKey)) return false;
    seen.add(ref.sourceKey);
    return true;
  });
}

function uniqueSourceRefs(sources: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.sessionID ?? ""}\u0000${source.messageID ?? ""}\u0000${source.role ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countValueTokens(text: string, value: string): number {
  if (!value) return 0;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
  return [...text.matchAll(expression)].length;
}

/** Full evidence → independent proposal → local admission → P01 transaction create. */
export async function runExtractCreate(
  sessionID: string,
  origin: "turn" | "session-review",
  deps: ExtractCreateDeps,
): Promise<ExtractCreateResult> {
  const configured = await deps.store.readConfig();
  const expectedRevision = configRevision(configured);
  if (
    deps.config.automation?.enabled !== true ||
    configured.automation?.enabled !== true ||
    deps.config.automation.mode === "off" ||
    configured.automation?.mode === "off"
  ) {
    return { created: 0, skipped: 0, reason: "disabled", deferred: true };
  }
  const shadowMode = deps.config.automation.mode === "shadow" || deps.config.shadow;
  if (!await deps.ownsNativeRoot(sessionID)) {
    return { created: 0, skipped: 0, reason: "unowned", deferred: true };
  }

  const capture = deps.capture ?? await captureExtractEvidence(
    sessionID,
    deps.reader,
    deps.excludeEvidence,
    {
      ...(deps.includeFailedTools ? { includeFailedTools: true } : {}),
      ...(deps.toolEvidence ? { toolEvidence: deps.toolEvidence } : {}),
      digestMaxChars: deps.config.digest.maxChars,
      learningMaxChars: deps.config.thresholds.memoryMaxChars,
    },
  );
  const { evidence } = capture;
  const capturedSpans = capture.spans;
  const captureRejected = capture.learningRejected ?? [];
  if (capturedSpans.length === 0) {
    if (evidence.spans.length > 0) {
      return { created: 0, skipped: 1, reason: "protected-evidence" };
    }
    return { created: 0, skipped: 0, reason: "no-user-evidence" };
  }

  // Freeze all relation targets and source epochs before any model dispatch.
  // The model can propose wording, but it cannot add a target or authorize a
  // version transition that was not in this local capture.
  const [captureItems, captureSuppressions] = await Promise.all([
    deps.store.listItems(),
    deps.store.listSuppressions(),
  ]);
  const spans: EvidenceSpan[] = [];
  const frozenBySpan = new Map<string, FrozenTargetSet>();
  const sourceEpochs = new Map<string, string>();
  let retiredCount = 0;
  const frozenAt = Date.now();
  for (const span of capturedSpans) {
    if (await isSourceRetired(deps.store, span.sessionID, span.messageID, span.observedAt)) {
      retiredCount += 1;
      continue;
    }
    spans.push(span);
    if (!sourceEpochs.has(span.messageID)) {
      sourceEpochs.set(span.messageID, await sourceEpoch(deps.store, sessionID, span.messageID, {
        items: captureItems,
        suppressions: captureSuppressions,
      }));
    }
    if (span.role === "tool") {
      // Learning is create-only: a tool failure never updates a user claim or
      // opens a relation target.
      frozenBySpan.set(spanKey(span), emptyTargetSet());
      continue;
    }
    const local = parseExtractClaim(span.text);
    if (local) {
      frozenBySpan.set(
        spanKey(span),
        freezeRelationTargets(captureItems, local, span.text, deps.projectKey, frozenAt),
      );
    }
  }
  if (spans.length === 0) {
    return retiredCount > 0
      ? { created: 0, skipped: retiredCount, reason: "retired-source" }
      : { created: 0, skipped: 1, reason: "protected-evidence" };
  }
  const evidenceChars = spans.reduce((total, span) => total + span.text.length, 0);
  if (evidenceChars > deps.config.review.maxInputChars) {
    return { created: 0, skipped: 0, reason: "evidence-over-budget" };
  }

  const originEpochHash = sha16(JSON.stringify([...sourceEpochs].sort(([a], [b]) => a.localeCompare(b))));
  const targetSetHash = sha16(JSON.stringify([...frozenBySpan]
    .map(([key, value]) => [key, value.hash, value.overflow])
    .sort(([left], [right]) => String(left).localeCompare(String(right)))));
  const proposals = await deps.provider.extract(spans, { originEpoch: originEpochHash, targetSetHash });
  const learningRejected: string[] = [...captureRejected];
  const candidates: ExtractCandidate[] = proposals.slice(0, deps.config.review.maxCandidates).flatMap((proposal): ExtractCandidate[] => {
    const located = locateUniqueQuote(proposal.quote, spans);
    if (!located) return [];
    const span = located.span;
    const frozenTargets = frozenBySpan.get(spanKey(span));
    const messageEpoch = sourceEpochs.get(span.messageID);
    if (!frozenTargets || !messageEpoch) return [];

    if (span.role === "tool") {
      const admission = admitToolLearning(
        proposal,
        located,
        deps.config.thresholds.memoryMaxChars,
      );
      if (!admission.ok) {
        learningRejected.push(admission.reason);
        return [];
      }
      if (!deps.projectKey) {
        learningRejected.push("no-project-key");
        return [];
      }
      const quoteHash = sha16(proposal.quote);
      const evidenceRef: EvidenceRef = {
        sessionID,
        messageID: span.messageID,
        role: "tool",
        observedRole: span.observedRole,
        offsetSpace: span.offsetSpace,
        start: located.start,
        end: located.end,
        quoteHash,
        canonicalHash: span.canonicalHash,
        partsHash: span.partsHash,
        tool: span.tool,
        ...(span.toolCallID ? { toolCallID: span.toolCallID } : {}),
        partIndex: span.partIndex,
        digestHash: span.digestHash,
        rawHash: span.rawHash,
        ...(deps.projectKey ? { originProjectKey: deps.projectKey } : {}),
        ...(span.observedAt !== undefined ? { observedAt: span.observedAt } : {}),
        sourceKey: sha16(JSON.stringify([
          sessionID,
          span.messageID,
          "tool",
          span.observedRole,
          span.offsetSpace,
          span.partIndex,
          span.toolCallID ?? "",
          span.digestHash,
          span.rawHash,
          located.start,
          located.end,
          quoteHash,
          span.canonicalHash,
          span.partsHash,
        ])),
      };
      return [{
        admission,
        evidenceRef,
        origin,
        span,
        sourceEpoch: messageEpoch,
        frozenTargets,
        reviewType: "learning" as const,
      }];
    }

    const admission = admitExtractProposal(
      proposal,
      located,
      deps.config.thresholds.memoryMaxChars,
    );
    if (!admission.ok || (admission.scope === "project" && !deps.projectKey)) return [];
    const claim = parseExtractClaim(admission.text);
    if (!claim) return [];
    const quoteHash = sha16(proposal.quote);
    const evidenceRef: EvidenceRef = {
      sessionID,
      messageID: span.messageID,
      role: "user",
      start: located.start,
      end: located.end,
      quoteHash,
      canonicalHash: span.canonicalHash,
      partsHash: span.partsHash,
      claimKey: extractClaimKey(claim),
      claimSubject: claim.subject,
      claimPredicate: claim.predicate,
      claimValue: claim.value,
      claimQualifiers: claim.qualifiers,
      claimPolarity: claim.polarity,
      claimIntent: claim.intent,
      ...(claim.oldValue ? { claimOldValue: claim.oldValue } : {}),
      claimProjectRelative: claim.projectRelative,
      ...(deps.repoIdentity ? { repoIdentity: deps.repoIdentity } : {}),
      ...(deps.projectKey ? { originProjectKey: deps.projectKey } : {}),
      explicitGlobal: claim.explicitGlobal,
      ...(span.observedAt !== undefined ? { observedAt: span.observedAt } : {}),
      sourceKey: sha16(JSON.stringify([
        sessionID,
        span.messageID,
        located.start,
        located.end,
        quoteHash,
        span.canonicalHash,
        span.partsHash,
      ])),
    };
    return [{
      admission,
      claim,
      evidenceRef,
      origin,
      span,
      sourceEpoch: messageEpoch,
      frozenTargets,
    }];
  });
  if (learningRejected.length > 0) {
    await deps.store.appendChangelog({
      action: "extract_learning_rejected",
      count: learningRejected.length,
      reasons: [...new Set(learningRejected)].slice(0, 8),
    });
  }
  if (candidates.length === 0) {
    return {
      created: 0,
      skipped: proposals.length,
      learningSkipped: learningRejected.length,
      reason: "no-local-admission",
    };
  }
  const learningRejectedCount = learningRejected.length;

  let created = 0;
  let updated = 0;
  let shadowed = 0;
  let learningSkipped = learningRejectedCount;
  let skipped = proposals.length - candidates.length + retiredCount;
  let deferredReason: "config-changed" | "unowned" | undefined;
  let changedInjectableView = false;
  let lastSuccess: { at: string; kind: Item["kind"]; itemID: string; action: "add" | "update" } | undefined;
  // Re-read native tool parts after the model call; a digest shown to the
  // model is not itself the raw source. Any hash/status drift skips learning.
  const toolFreshness = await verifyToolEvidence(
    candidates,
    deps.reader,
    deps.config.digest.maxChars,
    deps.config.thresholds.memoryMaxChars,
  );
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  await deps.store.transaction(async () => {
    const currentConfig = await deps.store.readConfig();
    if (
      configRevision(currentConfig) !== expectedRevision ||
      currentConfig.automation?.enabled !== true ||
      currentConfig.automation?.mode === "off"
    ) {
      skipped += candidates.length;
      deferredReason = "config-changed";
      return;
    }
    if (!await deps.ownsNativeRoot(sessionID)) {
      skipped += candidates.length;
      deferredReason = "unowned";
      return;
    }

    if (!shadowMode) {
      const maintenance = await expireLifecycleRecordsInTransaction(
        deps.store,
        (input) => recordChange(deps.store, input),
        nowMs,
      );
      changedInjectableView ||= maintenance.invalidated.length > 0;
    }
    const [items, suppressions] = await Promise.all([
      deps.store.listItems(),
      deps.store.listSuppressions(),
    ]);
    let workingItems = items;
    const sourceFresh = new Map<string, boolean>();
    for (const candidate of candidates) {
      const messageID = candidate.span.messageID;
      if (sourceFresh.has(messageID)) continue;
      const epoch = await sourceEpoch(deps.store, sessionID, messageID, { items, suppressions });
      const retired = await isSourceRetired(deps.store, sessionID, messageID, candidate.span.observedAt);
      sourceFresh.set(messageID, !retired && epoch === candidate.sourceEpoch);
    }
    const candidateFresh = new Map<ExtractCandidate, boolean>();
    for (const candidate of candidates) {
      let fresh = sourceFresh.get(candidate.span.messageID) === true;
      if (candidate.reviewType === "learning") {
        fresh = fresh && toolFreshness.get(candidate) === true;
      } else if (candidate.claim) {
        const currentTargets = freezeRelationTargets(
          items,
          candidate.claim,
          candidate.span.text,
          deps.projectKey,
          nowMs,
        );
        fresh = fresh && currentTargets.hash === candidate.frozenTargets.hash;
      } else {
        fresh = false;
      }
      candidateFresh.set(candidate, fresh);
    }

    const existingEvidence = new Set(
      items
        .filter((item) => item.status !== "archived" && item.status !== "false_positive")
        .flatMap((item) => (item.evidenceRefs ?? []).map((ref) => ref.sourceKey)),
    );
    const writtenSources = new Set<string>();
    const contentUpdated = new Set<string>();

    const holdCandidate = async (candidate: ExtractCandidate, reason: string): Promise<void> => {
      if (shadowMode) {
        skipped += 1;
        return;
      }
      const source: SourceRef = {
        sessionID,
        messageID: candidate.evidenceRef.messageID,
        role: candidate.evidenceRef.role,
        ...(deps.project ? { project: deps.project } : {}),
        ...(candidate.span.observedAt !== undefined ? { observedAt: candidate.span.observedAt } : {}),
      };
      await holdExtractQuarantine(deps.store, {
        text: candidate.admission.text,
        title: compact(candidate.admission.text).slice(0, deps.config.thresholds.titleMaxChars),
        kind: candidate.admission.kind,
        scope: candidate.admission.scope,
        ...(candidate.admission.scope === "project" && deps.projectKey
          ? { projectKey: deps.projectKey }
          : {}),
        source,
        reason,
        claimKey: candidate.evidenceRef.claimKey,
      }, nowMs);
      await deps.store.appendChangelog({ action: "extract_quarantined", reason, messageID: source.messageID });
      skipped += 1;
    };

    /**
     * Capacity admission runs inside the outer transaction on purpose: the
     * store skips reclaim while a batch is open, so this cannot re-enter the
     * maintenance gate or deadlock, and a rejected candidate never writes.
     */
    const admitWrite = async (
      candidate: ExtractCandidate,
      kind: Item["kind"],
    ): Promise<boolean> => {
      const admission = await admitAutoWrite(deps.store, deps.config, kind);
      if (admission.ok) return true;
      await holdCandidate(candidate, admission.blockedReason ?? "capacity");
      return false;
    };

    /** One daily/per-session slot, spent before a successful add or update. */
    const consumeBudget = () => deps.store.consumeWriteBudget({
      sessionID,
      dailyWrites: deps.config.automation.dailyWrites,
      maxWritesPerSession: deps.config.automation.maxWritesPerSession,
    });

    const recordShadow = async (
      candidate: ExtractCandidate,
      action: "add" | "update" | "seen",
      title: string,
    ): Promise<void> => {
      const source: SourceRef = {
        sessionID,
        messageID: candidate.evidenceRef.messageID,
        role: candidate.evidenceRef.role,
        ...(deps.project ? { project: deps.project } : {}),
        ...(candidate.span.observedAt !== undefined ? { observedAt: candidate.span.observedAt } : {}),
      };
      const record: ShadowRecord = {
        id: newId("shadow"),
        candidate: candidate.admission.text,
        title,
        kind: candidate.admission.kind,
        scope: candidate.admission.scope,
        ...(candidate.admission.scope === "project" && deps.projectKey
          ? { project: deps.project, projectKey: deps.projectKey }
          : {}),
        wouldWriteTo: candidate.admission.scope === "global" ? "global" : deps.projectKey ?? "project",
        wouldApply: 1,
        wouldRoute: "auto",
        wouldAction: action,
        hookID: candidate.evidenceRef.sourceKey,
        priority: 1,
        source,
        createdAt: now,
      };
      await deps.store.appendShadow(record, deps.config.caps.shadow);
      shadowed += 1;
    };

    const maybePromote = async (item: Item): Promise<void> => {
      if (item.scope !== "project") return;
      const promoted = await promoteGlobalCandidate(
        deps.store,
        (input) => recordChange(deps.store, input),
        item,
        nowMs,
      );
      if (promoted.promoted) {
        updated += 1;
        changedInjectableView = true;
        workingItems = await deps.store.listItems();
      }
    };

    for (const candidate of candidates) {
      const { admission, evidenceRef, claim, frozenTargets } = candidate;
      if (!candidateFresh.get(candidate)) {
        skipped += 1;
        if (candidate.reviewType === "learning") learningSkipped += 1;
        await deps.store.appendChangelog({
          action: candidate.reviewType === "learning"
            ? "extract_tool_source_changed"
            : "extract_source_changed",
          sessionID,
          messageID: candidate.span.messageID,
        });
        continue;
      }
      const source: SourceRef = {
        sessionID,
        messageID: evidenceRef.messageID,
        role: evidenceRef.role,
        ...(deps.project ? { project: deps.project } : {}),
        ...(candidate.span.observedAt !== undefined ? { observedAt: candidate.span.observedAt } : {}),
      };
      const keys = hookKeysFor(source, admission.text);
      const textHash = suppressionTextHash(admission.text);
      const suppressed = suppressions.some((row) =>
        keys.includes(row.hookKey) &&
        row.textHash === textHash &&
        (!row.until || Date.parse(row.until) > Date.now()),
      );
      if (suppressed || existingEvidence.has(evidenceRef.sourceKey) || writtenSources.has(evidenceRef.sourceKey)) {
        skipped += 1;
        if (candidate.reviewType === "learning") learningSkipped += 1;
        continue;
      }

      if (candidate.reviewType === "learning") {
        const title = compact(admission.text).slice(0, deps.config.thresholds.titleMaxChars);
        const lint = lintText({
          title,
          text: admission.text,
          kind: admission.kind,
          scope: admission.scope,
          maxChars: deps.config.thresholds.memoryMaxChars,
          titleMaxChars: deps.config.thresholds.titleMaxChars,
        });
        if (!lint.ok) {
          skipped += 1;
          learningSkipped += 1;
          continue;
        }
        if (shadowMode) {
          await recordShadow(candidate, "add", title);
          continue;
        }
        if (!await admitWrite(candidate, admission.kind)) continue;
        if (!(await consumeBudget()).ok) {
          await holdCandidate(candidate, "write-budget");
          continue;
        }
        const item: Item = {
          id: newId("item"),
          title,
          text: admission.text,
          kind: admission.kind,
          scope: "project",
          project: deps.project,
          projectKey: deps.projectKey,
          status: "auto",
          source,
          createdAt: now,
          updatedAt: now,
          seenCount: 1,
          lastSeenAt: now,
          sources: [source],
          origin,
          reviewType: "learning",
          evidenceRefs: [evidenceRef],
          changeID: newChangeID(),
        };
        await deps.store.appendItem(item);
        await recordChange(deps.store, {
          kind: "add",
          actor: "auto",
          itemID: item.id,
          item,
          source,
          origin,
          reason: "extract-learning",
        });
        existingEvidence.add(evidenceRef.sourceKey);
        writtenSources.add(evidenceRef.sourceKey);
        workingItems = [...workingItems, item];
        created += 1;
        lastSuccess = { at: now, kind: item.kind, itemID: item.id, action: "add" };
        changedInjectableView = true;
        continue;
      }

      if (!claim) {
        skipped += 1;
        continue;
      }

      if (frozenTargets.overflow) {
        await holdCandidate(candidate, "ambiguous-target-overflow");
        continue;
      }

      const frozenIDs = new Set(frozenTargets.targets.map((target) => target.item.id));
      const currentTargets = workingItems.filter((item) => frozenIDs.has(item.id));
      const exactTargets = frozenTargets.targets.filter((snapshot) =>
        claimsForItem(snapshot.item).some((existing) =>
          extractClaimKey(existing) === evidenceRef.claimKey),
      );
      let selectedSnapshot: FrozenTarget | undefined;
      if (exactTargets.length === 1) selectedSnapshot = exactTargets[0];
      else if (exactTargets.length > 1 || (frozenTargets.targets.length > 1 && exactTargets.length === 0)) {
        await holdCandidate(candidate, "ambiguous-target");
        continue;
      } else if (frozenTargets.targets.length === 1) {
        selectedSnapshot = frozenTargets.targets[0];
      }

      const title = compact(admission.text).slice(0, deps.config.thresholds.titleMaxChars);
      if (!selectedSnapshot) {
        const lint = lintText({
          title,
          text: admission.text,
          kind: admission.kind,
          scope: admission.scope,
          maxChars: deps.config.thresholds.memoryMaxChars,
          titleMaxChars: deps.config.thresholds.titleMaxChars,
        });
        if (!lint.ok) {
          skipped += 1;
          continue;
        }
        if (shadowMode) {
          await recordShadow(candidate, "add", title);
          continue;
        }
        if (!await admitWrite(candidate, admission.kind)) continue;
        if (!(await consumeBudget()).ok) {
          await holdCandidate(candidate, "write-budget");
          continue;
        }
        const item: Item = {
          id: newId("item"),
          title,
          text: admission.text,
          kind: admission.kind,
          scope: admission.scope,
          ...(admission.scope === "project" ? { project: deps.project, projectKey: deps.projectKey } : {}),
          status: "auto",
          source,
          createdAt: now,
          updatedAt: now,
          seenCount: 1,
          lastSeenAt: now,
          sources: [source],
          origin,
          evidenceRefs: [evidenceRef],
          changeID: newChangeID(),
        };
        await deps.store.appendItem(item);
        await recordChange(deps.store, {
          kind: "add",
          actor: "auto",
          itemID: item.id,
          item,
          source,
          origin,
          reason: "extract-create",
        });
        existingEvidence.add(evidenceRef.sourceKey);
        writtenSources.add(evidenceRef.sourceKey);
        workingItems = [...workingItems, item];
        created += 1;
        lastSuccess = { at: now, kind: item.kind, itemID: item.id, action: "add" };
        changedInjectableView = true;
        await maybePromote(item);
        continue;
      }

      const target = currentTargets.find((item) => item.id === selectedSnapshot?.item.id);
      if (!target || !activeForRelation(target, nowMs) ||
          itemContentVersion(target) !== selectedSnapshot.version) {
        skipped += 1;
        continue;
      }
      if (target.status !== "auto" || target.manual || target.kind === "rule") {
        await holdCandidate(candidate, "target-not-auto-writable");
        continue;
      }
      const targetClaims = claimsForItem(target).filter((existing) => sameClaimSubject(existing, claim));
      if (targetClaims.length === 0) {
        await holdCandidate(candidate, "relation-unresolved");
        continue;
      }
      const exactClaim = targetClaims.some((existing) => extractClaimKey(existing) === evidenceRef.claimKey);
      const baseRef = {
        ...target,
        seenCount: (target.seenCount ?? 1) + 1,
        lastSeenAt: now,
        sources: uniqueSourceRefs([...(target.sources ?? [target.source]), source]),
        evidenceRefs: uniqueEvidenceRefs([...(target.evidenceRefs ?? []), evidenceRef]),
      };
      if (exactClaim) {
        if (shadowMode) {
          await recordShadow(candidate, "seen", target.title);
          continue;
        }
        // A seen touch never rewrites the body, so autoUpdate=false and the
        // write budget do not apply; capacity admission still runs.
        if (!await admitWrite(candidate, target.kind)) continue;
        const written = await deps.store.replaceItem(baseRef);
        if (!written) {
          skipped += 1;
          continue;
        }
        workingItems = workingItems.map((item) => item.id === written.id ? written : item);
        await deps.store.appendChangelog({ action: "seen", itemID: written.id, sessionID, messageID: source.messageID });
        existingEvidence.add(evidenceRef.sourceKey);
        writtenSources.add(evidenceRef.sourceKey);
        await maybePromote(written);
        continue;
      }

      if (contentUpdated.has(target.id)) {
        await holdCandidate(candidate, "target-already-updated-in-batch");
        continue;
      }

      const sameValueClaims = targetClaims.filter((existing) =>
        normalizeClaimPart(existing.value) === normalizeClaimPart(claim.value) &&
        existing.polarity === claim.polarity,
      );
      let nextText: string | undefined;
      let reason: string | undefined;
      if (claim.intent === "replacement") {
        const oldValue = claim.oldValue ?? "";
        const oldMatches = targetClaims.filter((existing) =>
          normalizeClaimPart(existing.value) === normalizeClaimPart(oldValue) &&
          existing.polarity === claim.polarity,
        );
        const preservedQualifiers = oldMatches.length === 1 &&
          oldMatches[0].qualifiers.every((qualifier) =>
            claim.qualifiers.includes(qualifier) || qualifier.startsWith("replaces:"),
          );
        if (oldMatches.length !== 1 ||
            normalizeClaimPart(oldValue) === normalizeClaimPart(claim.value) ||
            !preservedQualifiers ||
            countValueTokens(target.text, oldValue) !== 1 ||
            countValueTokens(admission.text, oldValue) !== 1 ||
            countValueTokens(admission.text, claim.value) !== 1) {
          reason = "supersede-blocked";
        } else {
          // Keep the complete user correction as the new version. The before
          // snapshot retains the old value and the new quote keeps qualifiers.
          nextText = admission.text;
        }
      } else if (
        claim.polarity === "positive" &&
        ((claim.intent === "additive" && !sameValueClaims.some((entry) => extractClaimKey(entry) === evidenceRef.claimKey)) ||
          sameValueClaims.length > 0)
      ) {
        nextText = `${target.text}；${admission.text}`;
        reason = claim.intent === "additive" ? "extract-additive" : "extract-qualifier-update";
      } else {
        reason = "unverified-conflict";
      }
      if (!nextText) {
        await holdCandidate(candidate, reason ?? "unverified-conflict");
        continue;
      }
      if (deps.config.automation.autoUpdate === false) {
        await holdCandidate(candidate, "auto-update-disabled");
        continue;
      }
      if (nextText.length > deps.config.thresholds.memoryMaxChars) {
        await holdCandidate(candidate, "combined-body-over-budget");
        continue;
      }
      const nextTitle = compact(nextText).slice(0, deps.config.thresholds.titleMaxChars);
      const lint = lintText({
        title: nextTitle,
        text: nextText,
        kind: target.kind,
        scope: target.scope,
        maxChars: deps.config.thresholds.memoryMaxChars,
        titleMaxChars: deps.config.thresholds.titleMaxChars,
      });
      if (!lint.ok) {
        await holdCandidate(candidate, "updated-body-lint");
        continue;
      }
      const next: Item = {
        ...baseRef,
        title: nextTitle,
        text: nextText,
        updatedAt: now,
        changeID: newChangeID(),
      };
      if (shadowMode) {
        await recordShadow(candidate, "update", nextTitle);
        continue;
      }
      if (!await admitWrite(candidate, target.kind)) continue;
      if (!(await consumeBudget()).ok) {
        await holdCandidate(candidate, "write-budget");
        continue;
      }
      const written = await deps.store.replaceItem(next);
      if (!written) {
        skipped += 1;
        continue;
      }
      await recordChange(deps.store, {
        kind: "update",
        actor: "auto",
        itemID: written.id,
        item: written,
        before: target,
        source,
        origin,
        reason: reason ?? "extract-update",
      });
      workingItems = workingItems.map((item) => item.id === written.id ? written : item);
      contentUpdated.add(written.id);
      existingEvidence.add(evidenceRef.sourceKey);
      writtenSources.add(evidenceRef.sourceKey);
      updated += 1;
      lastSuccess = { at: now, kind: written.kind, itemID: written.id, action: "update" };
      changedInjectableView = true;
      await maybePromote(written);
    }
    if (lastSuccess && !shadowMode) {
      await deps.store.updateAutomationState({ lastSuccess });
    }
  });

  if (changedInjectableView) {
    await rebuildAutoFiles(deps.store).catch((error: unknown) => {
      deps.log?.("extract view rebuild failed", error);
    });
  }
  return deferredReason
    ? { created, skipped, updated, shadowed, learningSkipped, deferred: true, reason: deferredReason }
    : { created, skipped, updated, shadowed, learningSkipped };
}

/**
 * Re-read the native transcript after the model call and recompute each tool
 * digest. The model's quote was only a digest projection; it never becomes
 * evidence unless the raw part still matches both hashes and failed.
 */
async function verifyToolEvidence(
  candidates: ExtractCandidate[],
  reader: Pick<SessionReader, "readForEvidence">,
  digestMaxChars: number,
  learningMaxChars: number,
): Promise<Map<ExtractCandidate, boolean>> {
  const out = new Map<ExtractCandidate, boolean>();
  const toolCandidates = candidates.filter(
    (candidate) => candidate.span.role === "tool",
  );
  if (toolCandidates.length === 0) return out;
  let byID: Map<string, SessionMessage>;
  try {
    const messages = await reader.readForEvidence(toolCandidates[0].span.sessionID);
    byID = new Map(
      messages.flatMap((message) => message.id ? [[message.id, message] as const] : []),
    );
  } catch {
    for (const candidate of toolCandidates) out.set(candidate, false);
    return out;
  }
  for (const candidate of toolCandidates) {
    const span = candidate.span as ToolEvidenceSpan;
    const message = byID.get(span.messageID);
    const part = message?.parts?.[span.partIndex];
    let fresh = false;
    if (part && message &&
        part.type === "tool" &&
        part.tool === span.tool &&
        span.offsetSpace === "tool-projection" &&
        nativeToolMessageRole(message) === span.observedRole) {
      const callID = part.callID;
      if (!span.toolCallID || callID === span.toolCallID) {
        const digest = digestToolPart(
          part as unknown as Record<string, unknown>,
          { maxChars: digestMaxChars },
        );
        const projection = projectToolFailure(
          part as unknown as Record<string, unknown>,
          learningMaxChars,
        );
        fresh = digest !== undefined &&
          !digest.ok &&
          digest.id === span.digestHash &&
          digest.rawHash === span.rawHash &&
          projection.ok &&
          projection.tool === span.tool &&
          projection.digestHash === span.digestHash &&
          projection.rawHash === span.rawHash &&
          projection.text === candidate.admission.text;
      }
    }
    out.set(candidate, fresh);
  }
  return out;
}

/** Read and fingerprint the complete transcript once; persist only its digest. */
export async function captureExtractEvidence(
  sessionID: string,
  reader: Pick<SessionReader, "readForEvidence">,
  excludeEvidence?: ReviewEvidence[],
  options: ExtractCaptureOptions = {},
): Promise<ExtractEvidenceCapture> {
  // This bypasses the turn cache, message-count cap and text slimming. A read
  // error is non-writing, and the caller may share this exact capture with the
  // subsequent create run.
  const messages = await reader.readForEvidence(sessionID);
  const userEvidence = collectUserEvidence(sessionID, messages);
  const allowedUser = userEvidence.spans.filter((span) =>
    span.role === "user" &&
    !excludeEvidence?.some((entry) =>
      entry.kind === "user" &&
      entry.messageID === span.messageID &&
      span.text.includes(entry.quote),
    ),
  );

  const requestedTools = options.includeFailedTools === true &&
    (options.toolEvidence?.length ?? 0) > 0;
  let toolSpans: ToolEvidenceSpan[] = [];
  let toolMaterialHash = "";
  let learningRejected: string[] = [];
  if (requestedTools) {
    const toolCapture = collectFailedToolEvidence(
      sessionID,
      messages,
      options.learningMaxChars ?? 200,
    );
    toolMaterialHash = toolCapture.materialHash;
    learningRejected = toolCapture.rejected;
    const wanted = new Set(
      (options.toolEvidence ?? []).map((key) => `${key.messageID}\u0000${key.digestHash}`),
    );
    toolSpans = toolCapture.spans.filter((span) =>
      wanted.has(`${span.messageID}\u0000${span.digestHash}`),
    );
  }

  const spans: EvidenceSpan[] = [...allowedUser, ...toolSpans];
  const evidence: EvidenceBundle = {
    spans: [...userEvidence.spans, ...toolSpans],
    hash: requestedTools
      ? sha16(JSON.stringify([userEvidence.hash, toolMaterialHash]))
      : userEvidence.hash,
    materialHash: requestedTools
      ? sha16(JSON.stringify([userEvidence.materialHash, toolMaterialHash]))
      : userEvidence.materialHash,
    chars: spans.reduce((total, span) => total + span.text.length, 0),
  };
  return { evidence, spans, ...(requestedTools ? { learningRejected } : {}) };
}

function configRevision(config: AutoMemConfig): string {
  const { token: _token, dataDir: _dataDir, ...rest } = config;
  return sha16(JSON.stringify(rest));
}
