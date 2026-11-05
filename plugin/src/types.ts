export type ItemKind = "fact" | "preference" | "rule" | "reference" | "skill";
export type ItemStatus = "auto" | "queue" | "shadow" | "promoted" | "false_positive" | "archived";
export type Scope = "session" | "project" | "global";
export type MergeAction = "create" | "merge_into" | "replace" | "keep_both" | "reject_duplicate";
export type ReviewType = "fact" | "preference" | "rule" | "decision" | "learning" | "skill";
export type ReviewStatus = "scheduled" | "running" | "ready" | "failed" | "skipped";

export interface ReviewEvidence {
  messageID: string;
  quote: string;
  kind: "user" | "tool";
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
  /** Hooks actually created after accept-time dedupe. */
  queued?: number;
  dropped: number;
  durationMs?: number;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
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
  /** Rendered memory pinned for this session; new memory waits for a new session. */
  contextBlock?: AutopilotContext;
  contextHash?: string;
  contextProjectKey?: string;
}

export interface PersistedState {
  sessions: Record<string, SessionState>;
  lastAuditAt?: string;
  /** Last deterministic curator pass; used for the 24h gate. */
  lastCuratedAt?: string;
  /** Timestamps of review model calls in the last hour, shared across restarts. */
  reviewRuns?: number[];
  /** Actual attempted model requests, including repairs/retries, shared by processes. */
  modelRequests?: Partial<Record<"decision" | "rewrite" | "review", number[]>>;
}

export interface SourceRef {
  sessionID?: string;
  project?: string;
  messageID?: string;
  role?: "user" | "assistant" | "system";
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
  reviewID?: string;
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
  digest: DigestConfig;
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
  content?: Array<{ type: string; text?: string; tool?: string; state?: unknown }>;
  parts?: Array<{ type: string; text?: string; tool?: string; state?: unknown }>;
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
}

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
