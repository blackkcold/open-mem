export type ItemKind = "fact" | "preference" | "rule" | "reference" | "skill";
export type ItemStatus = "auto" | "queue" | "shadow" | "promoted" | "false_positive" | "archived";
export type Scope = "session" | "project" | "global";
export type MergeAction = "create" | "merge_into" | "replace" | "keep_both" | "reject_duplicate";
export type ReviewType = "fact" | "preference" | "rule" | "decision" | "learning" | "skill";
export type ReviewStatus = "scheduled" | "running" | "ready" | "failed" | "skipped";
export type AutomationMode = "off" | "shadow" | "autonomous";

export interface ExtractPendingWork {
  origin: "turn" | "session-review";
  /** First persisted time; retries do not extend the 72h retention window. */
  createdAt?: string;
  projectKey?: string;
  windowHash?: string;
  /** Non-secret fingerprint of extraction-relevant mode/model settings. */
  configHash?: string;
  reason: "in-flight" | "configuration" | "owner" | "request-budget" | "retry-after" | "transport" | "circuit" | "format" | "capacity";
  /** Provider/budget eligibility time, including waits that are not timer-driven. */
  retryAt?: string;
  dueAt?: string;
  /** Cumulative provider requests actually dispatched for this window, including Retry-After responses. */
  dispatches?: number;
  /** Failed non-waiting request count; the dispatch cap is tracked separately. */
  attempts: number;
  updatedAt: string;
}

export interface ReviewEvidence {
  messageID: string;
  quote: string;
  kind: "user" | "tool";
  /** Native message creation time for the retired-source overflow barrier. */
  observedAt?: number;
}

export interface ReviewCandidate {
  type: ReviewType;
  text: string;
  scope: Scope;
  confidence: number;
  evidence: ReviewEvidence[];
  /** True when the instruction only applies to this task/session. */
  taskOnly?: boolean;
  /** Why the model chose project/global; omitted for session. */
  scopeEvidence?: string;
  /** Required for skill candidates. */
  steps?: string[];
}

export interface ReviewSessionNote {
  status?: "promoted" | "dismissed";
  promotedItemID?: string;
  type: ReviewType;
  text: string;
  evidence: ReviewEvidence[];
  taskOnly?: boolean;
  createdAt: string;
}

export interface ReviewRecord {
  id: string;
  sessionID: string;
  projectKey?: string;
  status: ReviewStatus;
  createdAt: string;
  fromMessageID?: string;
  toMessageID?: string;
  inputHash?: string;
  chars?: number;
  candidates: number;
  /** Hooks actually created after accept-time dedupe (protected rule/skill lane). */
  queued?: number;
  /** Ordinary review-origin items written by the single P01 writer. */
  learned?: number;
  /** Existing items updated by verified ordinary evidence. */
  updated?: number;
  /** Would-write records produced in shadow mode; never active items. */
  shadowed?: number;
  /** Failing-tool learning candidates skipped with a recorded local reason. */
  learningSkipped?: number;
  /** Protected rule/skill candidates routed to the legacy hook lane. */
  protectedCandidates?: number;
  /** Visible reason when ordinary learning was deferred rather than skipped. */
  learningDeferred?: string;
  dropped: number;
  durationMs?: number;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  /** Machine-readable failure class for status/tests. */
  errorKind?: "transport" | "http" | "empty" | "format" | "budget" | "config" | "cache" | "retry-after";
  /** Why a run was skipped, when status is "skipped". */
  note?: string;
  summary?: string[];
  openQuestions?: string[];
  /** Session-only candidates; never hooks, queue items or injected memory. */
  sessionNotes?: ReviewSessionNote[];
}

export interface ReviewRunResult {
  summary: string[];
  openQuestions: string[];
  candidates: ReviewCandidate[];
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
  cached?: boolean;
}

export interface SessionState {
  lastActiveAt?: string;
  lastMessageID?: string;
  lastScannedMessageID?: string;
  lastTurnID?: string;
  lastRunAt?: string;
  /** Child sessions (subagents) are not memory sources. */
  parentSessionID?: string;
  agent?: string;
  /** Set once parent/agent metadata has been read (event or session.get). */
  parentChecked?: boolean;
  reviewDueAt?: string;
  reviewStatus?: ReviewStatus;
  /** Why the last window was deferred (not failed). */
  reviewDeferredReason?: "request-budget" | "retry-after" | "extract-state" | "extract-transport";
  reviewAttempts?: number;
  reviewDeferrals?: number;
  reviewUserIDAtSchedule?: string;
  reviewedUpToMessageID?: string;
  reviewedHash?: string;
  /** Hash of the window that last failed; used to tell new material apart. */
  reviewAttemptedHash?: string;
  /** In-flight claim, so a sibling instance does not run the same window twice. */
  reviewStartedAt?: string;
  /** Tail of the window that last skipped; prevents re-arming an unchanged window. */
  reviewSkipToMessageID?: string;
  reviewSkipHash?: string;
  reviewSkipAt?: string;
  pendingReview?: boolean;
  /** Durable extract retry marker; contains hashes/metadata, never transcript text. */
  extractPending?: ExtractPendingWork;
  /** Last 16 distinct expired material hashes; hash-only terminal history survives config changes/restarts. */
  extractExpiredWindowHashes?: string[];
  /** Rendered memory pinned for this session; new memory waits for a new session. */
  contextBlock?: AutopilotContext;
  contextHash?: string;
  contextProjectKey?: string;
  /**
   * Native host session directory captured from `session.created` or
   * `session.get`. Automatic collection/review requires this evidence; the
   * contextProjectKey alone is only a hint and must not prove ownership.
   */
  sessionDirectory?: string;
  /** Memory version the pinned block was built from; drives per-request invalidation. */
  contextVersion?: string;
}


export interface PersistedState {
  sessions: Record<string, SessionState>;
  automation?: PersistedAutomationState;
  lastAuditAt?: string;
  /** Last deterministic curator pass; used for the 24h gate. */
  lastCuratedAt?: string;
  /** Timestamps of review model calls in the last hour, shared across restarts. */
  reviewRuns?: number[];
  /** Review/extract request timestamps retained for the shared rolling-day quota. */
  modelRequests?: Partial<Record<"decision" | "rewrite" | "review", number[]>>;
  /** Purpose labels for the shared review/extract request timestamps. */
  modelRequestPurposes?: Array<{ at: number; purpose: "review" | "extract" }>;
}

export interface RetentionHistorySnapshot {
  at: string;
  deleted: { changes: number; journals: number; suppressions: number; quarantine: number };
  reclaimedBytes: number;
  /** Safe derived-history bytes still removable after this run (0 if none). */
  remainingReclaimableBytes: number;
  protected: { changes: number; journals: number; suppressions: number };
  blocked: boolean;
  blockedReasons: string[];
  notes: string[];
  /** Only set when blocked: the next interval tick may retry. */
  nextAttemptAt?: string;
}

export interface PersistedAutomationState {
  /** Number of capture attempts rejected while the pending ledger was full. */
  pendingFull?: number;
  pendingCapacityBlocked?: boolean;
  expiredUnlearned?: number;
  lastExtractAt?: string;
  capacityBlockedUntil?: string;
  lastSuccess?: {
    at: string;
    kind: ItemKind;
    itemID: string;
    action: "add" | "update";
  };
  lastMaintenanceAt?: string;
  /** Last bounded derived-history reclaim; read-only UI/status snapshot. */
  retention?: RetentionHistorySnapshot;
  /** Persistent cooldown for both automatic retention paths (not a lease). */
  retentionGate?: { lastAttemptAt: string; nextAttemptAt: string };
  /**
   * Successful automatic item writes for the current UTC day. The counter is
   * written inside the write transaction, so a rollback does not spend a slot.
   */
  writeBudget?: {
    day: string;
    count: number;
    sessions: Record<string, number>;
  };
}

export interface SourceRef {
  sessionID?: string;
  project?: string;
  messageID?: string;
  role?: "user" | "assistant" | "system" | "tool";
  /** Native source time; absent values remain fail-closed behind a barrier. */
  observedAt?: number;
}

/** Hash-only pointer into a user message or a failing native tool part. */
export interface EvidenceRef {
  sessionID: string;
  messageID: string;
  role: "user" | "tool";
  /** Explicit observed authority; model output never fills this field. */
  observedRole?: "user" | "assistant" | "tool";
  /** Offset space of start/end: user canonical text or a tool projection. */
  offsetSpace?: "user-canonical" | "tool-projection";
  /** UTF-16 offsets into the canonical concatenated message text. */
  start: number;
  end: number;
  quoteHash: string;
  canonicalHash: string;
  partsHash: string;
  sourceKey: string;
  /** Native tool identity for failing-tool learning; hashes only, never raw args/output. */
  tool?: string;
  toolCallID?: string;
  partIndex?: number;
  digestHash?: string;
  rawHash?: string;
  /** Local, hash-only claim metadata; excluded from itemContentVersion. */
  claimKey?: string;
  claimSubject?: string;
  claimPredicate?: string;
  claimValue?: string;
  claimQualifiers?: string[];
  claimPolarity?: "positive" | "negative";
  claimIntent?: "ordinary" | "additive" | "replacement";
  claimOldValue?: string;
  claimProjectRelative?: boolean;
  repoIdentity?: string;
  originProjectKey?: string;
  explicitGlobal?: boolean;
  observedAt?: number;
}

export interface RetiredSourceItem {
  itemID: string;
  changeID: string;
  reason: "deactivate" | "revert" | "undo";
  claimKey?: string;
}

/** Durable message-level learning tombstone. It intentionally has no TTL. */
export interface RetiredSource {
  sessionID: string;
  messageID: string;
  items: RetiredSourceItem[];
  quoteHashes: string[];
  firstRetiredAt: string;
  lastRetiredAt: string;
  version: number;
}

/** Bounded overflow barrier; epoch never decreases or disappears on mode changes. */
export interface RetiredSourceState {
  epoch: number;
  blockedAt?: number;
  reason?: "retired-source-capacity";
}

/** No transcript or rawQuote is permitted in this cross-project ledger. */
export interface GlobalCandidate {
  claimKey: string;
  evidenceRefID: string;
  quoteHash: string;
  repoIdentity: string;
  originProjectKey: string;
  createdAt: string;
}

export interface GlobalCandidateState {
  epoch: number;
  blocked: boolean;
  reason?: "global-candidate-capacity";
}

/** Short-lived, non-approval holding area for ambiguous ordinary relations. */
export interface ExtractQuarantineRecord {
  id: string;
  at: string;
  expiresAt: string;
  text: string;
  title: string;
  kind: ItemKind;
  scope: Scope;
  projectKey?: string;
  source: SourceRef;
  reason: string;
  claimKey?: string;
}

export interface LifecycleStatus {
  retiredSources: number;
  retiredBytes: number;
  retiredLearningBlocked: boolean;
  retiredBlockReason?: "retired-source-capacity";
  globalCandidates: number;
  globalCandidateBytes: number;
  globalPromotionBlocked: boolean;
  quarantine: number;
  oldestQuarantineExpiry?: string;
}

export type Strictness =
  | "preference"
  | "workflow"
  | "format"
  | "strict_limit"
  | "permission"
  | "safety"
  | "destructive"
  | "unknown";

export interface DecisionResult {
  kind: ItemKind | "ignore";
  duplicate: number;
  safeAuto: number;
  risk: number;
  confidence: number;
  strictness: Strictness;
  reasons: string[];
  source: "systemone" | "heuristic" | "jev" | "review";
  mergeAction?: MergeAction;
  mergeTargetId?: string;
  conflict?: number;
  safety?: number;
  strictLimit?: number;
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs?: number;
  model?: string;
  cached?: boolean;
}

/** @deprecated Use DecisionResult. Kept so old stored records keep type-checking. */
export type JevResult = DecisionResult;

export interface PriorityBreakdown {
  risk: number;
  impact: number;
  uncertainty: number;
  age: number;
}

export interface Item {
  id: string;
  title: string;
  text: string;
  kind: ItemKind;
  scope: Scope;
  project?: string;
  /** Stable project identity for injection filtering. */
  projectKey?: string;
  /** Optional TTL for volatile facts. */
  expiresAt?: string;
  /** True when a user approved/promoted this item; curator must not expire it. */
  manual?: boolean;
  status: ItemStatus;
  source: SourceRef;
  createdAt: string;
  updatedAt: string;
  decision?: DecisionResult;
  /** @deprecated Old field name; read through `decisionOf()`. */
  jev?: JevResult;
  priority?: number;
  priorityBreakdown?: PriorityBreakdown;
  tags?: string[];
  deferredUntil?: string;
  seenCount?: number;
  sources?: SourceRef[];
  lastSeenAt?: string;
  fingerprint?: string;
  supersededBy?: string;
  aliases?: string[];
  /** Where the candidate came from. Absent means the per-turn capture path. */
  origin?: "turn" | "session-review";
  reviewType?: ReviewType;
  evidence?: ReviewEvidence[];
  evidenceRefs?: EvidenceRef[];
  /** Local link for a transactional project→global promotion group. */
  linkGroupID?: string;
  /** Claim key whose implicit cross-project evidence manages this global row. */
  implicitGlobalClaimKey?: string;
  reviewID?: string;
  /** Most recent change event that produced this version. */
  changeID?: string;
  /** Set when an upstream item/change made this row stop being injected. */
  invalidatedBy?: string;
  invalidatedAt?: string;
  /** Upstream item ids this row was derived from. */
  derivedFrom?: string[];
}

export interface Suggestion {
  id: string;
  queueID: string;
  action: MergeAction;
  targetId?: string;
  targetTitle?: string;
  targetVersion?: string;
  proposedTitle: string;
  proposedText: string;
  preserved: string[];
  dropped: Array<{ text: string; reason: string }>;
  rationale: string;
  confidence: number;
  source: "systemtwo" | "composer" | "human";
  model?: { providerID: string; id: string };
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  createdAt: string;
}

export interface QueueItem extends Item {
  reason: string;
  diff?: string;
  suggestedAction?: "approve" | "deny" | "edit" | "defer" | "merge" | "promote";
  /** Turn and hook that produced this review item. */
  turnID?: string;
  hookID?: string;
  suggestion?: Suggestion;
  suggestionState?: "pending" | "ready" | "failed";
  suggestionError?: string;
  /**
   * Derived at read time from curated L0/L2 files. Never persisted with the
   * queue row and never part of its decision/version snapshot.
   */
  coverage?: Array<{
    source: string;
    sourceId: string;
    heading: string;
    line: number;
    relation: string;
    score: number;
    reasons?: string[];
  }>;
  /** Computed over every match before `coverage` is sliced for display. */
  coverageSummary?: {
    relation: string;
    conflictCount: number;
    mismatchCount: number;
    coveredCount: number;
    total: number;
    analysisVersion: string;
  };
}

export interface ShadowRecord {
  id: string;
  candidate: string;
  title: string;
  kind: ItemKind;
  scope: Scope;
  project?: string;
  projectKey?: string;
  wouldWriteTo: string;
  wouldApply: number;
  /** What the candidate would have done if shadow were off. */
  wouldRoute?: "auto" | "queue";
  wouldAction?: "add" | "update" | "seen";
  turnID?: string;
  hookID?: string;
  decision?: DecisionResult;
  /** @deprecated Old field name. */
  jev?: JevResult;
  priority: number;
  source: SourceRef;
  createdAt: string;
  falsePositive?: boolean;
  falsePositiveAt?: string;
}

export type HookStatus =
  | "pending"
  | "blocked"
  | "processing"
  | "auto"
  | "shadow"
  | "queue"
  | "ignored"
  | "failed";

/** A durable capture of one memory-worthy user sentence. */
export interface HookRecord {
  id: string;
  /** sessionID + messageID + normalized text hash; used for idempotent capture. */
  key: string;
  sessionID: string;
  turnID: string;
  messageID: string;
  text: string;
  title: string;
  trigger: string;
  scope: Scope;
  project?: string;
  /** Stable project identity copied from the capture context. */
  projectKey?: string;
  source: SourceRef;
  createdAt: string;
  updatedAt: string;
  status: HookStatus;
  attempts: number;
  decision?: DecisionResult;
  queueID?: string;
  itemID?: string;
  shadowID?: string;
  error?: string;
  origin?: "turn" | "session-review";
  reviewType?: ReviewType;
  evidence?: ReviewEvidence[];
  reviewID?: string;
  reviewConfidence?: number;
}

export interface TurnSummary {
  sessionID: string | null;
  turnID: string | null;
  createdAt: string | null;
  counts: {
    captured: number;
    pending: number;
    auto: number;
    shadow: number;
    queue: number;
    ignored: number;
    failed: number;
  };
  hooks: HookRecord[];
}

export interface SkillValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface SkillDraft {
  id: string;
  name: string;
  description: string;
  status: "draft" | "validated" | "approved" | "rejected";
  path: string;
  validation: SkillValidation;
  testResult?: { ok: boolean; notes: string };
  source?: SourceRef;
  createdAt: string;
  updatedAt: string;
}

export interface AuditFinding {
  id: string;
  severity: "info" | "warning" | "error";
  kind:
    | "duplicate"
    | "conflict"
    | "classification"
    | "coverage"
    | "stale"
    | "capacity"
    | "secret"
    | "skill"
    | "queue"
    | "shadow"
    | "lint"
    | "merge"
    | "decision";
  title: string;
  detail: string;
  itemIDs: string[];
  suggestedAction?: string;
}

export interface AuditReport {
  generatedAt: string;
  /** Set only by runAudit; absent means no audit has run (auditAgeMs = null). */
  auditRunAt?: string;
  findings: AuditFinding[];
  summary: { error: number; warning: number; info: number };
}

export interface Metrics {
  generatedAt: string;
  items: number;
  queue: number;
  shadow: number;
  auto: number;
  promoted: number;
  falsePositive: number;
  falsePositiveRate: number;
  queueAgeP50Hours: number;
  queueAgeP95Hours: number;
  skillDrafts: number;
  auditFindings: number;
}

export interface DecisionConfig {
  kind: "systemone" | "heuristic";
  endpoint: string;
  model: string;
  apiKeyEnv: string;
  timeoutMs: number;
  maxCallsPerHour: number;
  cacheTtlHours: number;
  /** Candidates below this safeAuto score are ignored instead of queued. */
  queueMin: number;
  /** Rule floor; lower-confidence low-risk rules are ignored instead of queued. */
  queueMinRule: number;
}

export interface ModelRef {
  providerID: string;
  id: string;
  /** Provider variant, e.g. "high" for reasoning effort. */
  variant?: string;
}

export interface RewriteConfig {
  enabled: boolean;
  transport: "opencode" | "ollama";
  model: ModelRef;
  endpoint: string;
  timeoutMs: number;
  maxCallsPerHour: number;
  repairAttempts: number;
  eager: boolean;
  cacheTtlHours: number;
}

export interface DigestConfig {
  maxEntries: number;
  maxBytes: number;
  maxChars: number;
}

export interface ReviewConfig {
  enabled: boolean;
  /** Review transport; independent from rewrite.transport. Missing = ollama. */
  transport?: "opencode" | "ollama";
  /** Quiet period after the last turn before a session review runs. */
  idleMs: number;
  minNewUserMessages: number;
  /** Long sessions are reviewed once this many new messages accumulated. */
  checkpointMessages: number;
  maxInputChars: number;
  maxUserCharsPerMessage: number;
  maxCandidates: number;
  minConfidence: number;
  maxPerHour: number;
  /** Request budget; missing = max(maxPerHour, maxPerHour*(1+repairAttempts)*2). */
  maxRequestsPerHour?: number;
  /** Upper bound for the model's JSON reply; keeps zero-candidate runs cheap. */
  maxOutputTokens: number;
  transcript: "user" | "user+tools";
  redact: boolean;
  timeoutMs: number;
  repairAttempts: number;
  cacheTtlHours: number;
  model: ModelRef;
  /** Extra quiet periods granted while the user keeps typing. */
  maxDeferrals: number;
}

/** Bounded per-request recall. `enabled` is optional and inherits automation. */
export interface RecallConfig {
  /** Absent = inherit `automation.enabled`; explicit false still filters stale prefixes. */
  enabled?: boolean;
  limit: number;
  tokenBudget: number;
  apiLimit: number;
  apiTokenBudget: number;
}

/** Narrow opt-in gate for the create-only autonomous extract lane. */
export interface AutomationConfig {
  enabled: boolean;
  /** Absent on old configurations; absence preserves the legacy behavior. */
  mode?: AutomationMode;
  /** Monotonic mode-switch revision; initialized by the mode endpoint. */
  revision?: number;
  /** Shared daily review/extract request ceiling; never raised above 40. */
  dailyModelCalls?: number;
  /** Content updates rewrite an existing body; false quarantines them. */
  autoUpdate?: boolean;
  /** Successful automatic item writes allowed per UTC day. */
  dailyWrites?: number;
  /** Successful automatic item writes allowed per session per UTC day. */
  maxWritesPerSession?: number;
}

export interface AutoMemConfig {
  version: 1;
  shadow: boolean;
  /** In shadow mode, record every non-ignore candidate, not only auto-allowed ones. */
  shadowRecordAll: boolean;
  autoMemory: boolean;
  autoRules: boolean;
  /** @deprecated Kept for old config files. */
  decisionModel?: { providerID: string; id: string };
  dataDir?: string;
  console?: boolean;
  port?: number;
  token?: string;
  decision: DecisionConfig;
  rewrite: RewriteConfig;
  review: ReviewConfig;
  /** Missing in older persisted configs; mergeConfig supplies disabled. */
  automation: AutomationConfig;
  /** Missing in older persisted configs; merged defaults never enable it. */
  recall: RecallConfig;
  digest: DigestConfig;
  /** Undo/version-retention policy. Deactivate is never time limited. */
  undo: UndoConfig;
  turn: {
    /** Maximum hooks processed in one turn batch. */
    maxCandidates: number;
    /** Decision calls that may run at once; writes stay serialized. */
    parallel: number;
  };
  thresholds: {
    memoryMaxChars: number;
    ruleMaxChars: number;
    titleMaxChars: number;
    autoOkMin: number;
    globalAutoOkMin: number;
    duplicateMax: number;
  };
  caps: {
    autoMemory: number;
    autoRules: number;
    queue: number;
    shadow: number;
    skillDrafts: number;
    itemsTotal: number;
    suggestions: number;
    /** Upper bound for hooks.jsonl before settled records are pruned. */
    hooks: number;
    /** Upper bound for reviews.jsonl (session review history). */
    reviews: number;
    diskBytes: number;
  };
}

export interface AutopilotContext {
  version: 1;
  autoMemory: string[];
  autoRules: string[];
  shadow: boolean;
}

export interface SessionMessage {
  id?: string;
  type?: string;
  role?: string;
  text?: string;
  /** Raw message metadata; synthetic/warming markers live here on V2. */
  metadata?: unknown;
  content?: Array<{ type: string; text?: string; tool?: string; callID?: string; state?: unknown }>;
  parts?: Array<{ type: string; text?: string; tool?: string; callID?: string; state?: unknown }>;
  time?: { created?: number; completed?: number };
}

export interface DecisionNeighbor {
  id: string;
  title: string;
  text: string;
  kind: ItemKind;
  scope: Scope;
  status: string;
  similarity: number;
}

export interface DecisionInput {
  candidate: string;
  title: string;
  existingTitles: string[];
  neighbors?: DecisionNeighbor[];
  scope: Scope;
  project?: string;
}

export interface DecisionProvider {
  classify(input: DecisionInput): Promise<DecisionResult>;
}

export interface SkillInput {
  name?: string;
  title: string;
  description?: string;
  scenario: string;
  references?: string[];
  source?: SourceRef;
}

export interface AppConfig extends AutoMemConfig {
  version: 1;
}

export interface UsageRecord {
  at: string;
  kind: "decision" | "rewrite";
  provider: string;
  model: string;
  latencyMs: number;
  ok: boolean;
  fallback?: string;
  inputTokens?: number;
  outputTokens?: number;
  status?: number;
  error?: string;
}

export interface UsageSummary {
  decisionCalls: number;
  decisionTokens: number;
  rewriteCalls: number;
  rewriteTokens: number;
  reviewCalls: number;
  reviewTokens: number;
  reviewFailures: number;
  decisionFallbackRate: number;
  rewriteFallbackRate: number;
  since: string;
}

export interface MergeJournal {
  id: string;
  at: string;
  action: MergeAction;
  queueID: string;
  targetID?: string;
  before: { target?: Item; queue: QueueItem };
  after: { itemID?: string; targetText?: string; target?: Item; item?: Item };
  /** A started undo can safely resume after a crash between file writes. */
  undoing?: boolean;
  undone?: boolean;
  /** The user changed the proposed title/text before applying. */
  humanEdited?: boolean;
}

export type ChangeKind =
  | "add"
  | "update"
  | "merge"
  | "replace"
  | "archive"
  | "revert"
  | "restore"
  | "deactivate"
  | "expire"
  | "invalidate"
  | "promote"
  | "migration";

export type ChangeActor = "auto" | "user" | "curator" | "migration" | "system";

/**
 * Lossless full snapshot. Restoring it must bring back identity, status,
 * provenance and derivation, not only the body text.
 */
export type ItemSnapshot = Item;

export interface ChangeEvent {
  id: string;
  at: string;
  kind: ChangeKind;
  actor: ChangeActor;
  itemID: string;
  /** post-change content version; absent when the item is gone */
  itemVersion?: string;
  before?: ItemSnapshot;
  after?: ItemSnapshot;
  source: SourceRef;
  origin?: "turn" | "session-review" | "curator" | "migration" | "user";
  /** other change ids this event depends on (merge inputs, supersede chain) */
  dependsOn?: string[];
  /** upstream item ids */
  derivedFrom?: string[];
  linkGroupID?: string;
  reason: string;
  /** change being reverted, for kind=revert */
  reverts?: string;
  revertible: boolean;
}

/** On-disk redo/undo record for one change event. */
export interface ChangeJournal {
  id: string;
  at: string;
  itemID: string;
  kind: ChangeKind;
  before?: ItemSnapshot;
  after?: ItemSnapshot;
  reverts?: string;
  undoing?: boolean;
  undone?: boolean;
}

export interface Suppression {
  id: string;
  at: string;
  /** exact hook key, e.g. turn|session|message|textHash or review|... */
  hookKey: string;
  textHash: string;
  itemID: string;
  reason: "reverted" | "deactivated";
  /** only same-source re-learning is suppressed; a new message is not */
  until?: string;
}

export interface UndoConfig {
  /** Version restore window; deactivate/reactivate are never time limited. */
  retainDays: number;
}

export type RevertResult =
  | { ok: true; event: ChangeEvent; invalidated: string[] }
  | {
      ok: false;
      code: "not_found" | "version_mismatch" | "not_revertible" | "conflict";
      message: string;
    };


export interface HealthScore {
  score: number;
  grade: "good" | "ok" | "warn" | "bad";
  generatedAt: string;
  breakdown: {
    capacity: number;
    duplicates: number;
    conflicts: number;
    falsePositive: number;
    queueAge: number;
    decisionFallback: number;
    rewriteFallback: number;
    acceptance: number;
    undo: number;
  };
  details: {
    items: number;
    queue: number;
    shadow: number;
    duplicateRate: number;
    conflictCount: number;
    falsePositiveRate: number;
    queueAgeP95Hours: number;
    decisionCalls: number;
    rewriteCalls: number;
    suggestionAcceptance: number;
    undoCount: number;
    capacityRatio: number;
  };
}
