export type MergeAction =
  | "create"
  | "merge_into"
  | "replace"
  | "keep_both"
  | "reject_duplicate";

export interface DecisionResult {
  kind: string;
  duplicate: number;
  safeAuto: number;
  risk: number;
  confidence: number;
  strictness: string;
  reasons: string[];
  source: string;
  mergeAction?: MergeAction;
  mergeTargetId?: string;
  conflict?: number;
  safety?: number;
  strictLimit?: number;
  latencyMs?: number;
  model?: string;
  cached?: boolean;
}

export interface PriorityBreakdown {
  risk: number;
  impact: number;
  uncertainty: number;
  age: number;
}

export interface SourceRef {
  sessionID?: string;
  project?: string;
  messageID?: string;
  role?: string;
}

export interface Suggestion {
  id: string;
  queueID: string;
  action: MergeAction;
  targetId?: string;
  targetTitle?: string;
  proposedTitle: string;
  proposedText: string;
  preserved: string[];
  dropped: Array<{ text: string; reason: string }>;
  rationale: string;
  confidence: number;
  source: "systemtwo" | "composer" | "human";
  model?: { providerID: string; id: string; variant?: string };
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  createdAt: string;
}

export type ReviewType = "fact" | "preference" | "rule" | "decision" | "learning" | "skill";

export interface ReviewEvidence {
  messageID: string;
  quote: string;
  kind: "user" | "tool";
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
  status: "scheduled" | "running" | "ready" | "failed" | "skipped";
  createdAt: string;
  fromMessageID?: string;
  toMessageID?: string;
  inputHash?: string;
  chars?: number;
  candidates: number;
  queued?: number;
  /** Ordinary review-origin items written by the P01 writer. */
  learned?: number;
  updated?: number;
  shadowed?: number;
  learningSkipped?: number;
  protectedCandidates?: number;
  learningDeferred?: string;
  dropped: number;
  durationMs?: number;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  note?: string;
  summary?: string[];
  openQuestions?: string[];
  sessionNotes?: ReviewSessionNote[];
}

export interface QueueItem {
  id: string;
  title: string;
  text: string;
  kind: string;
  scope: string;
  project?: string;
  projectKey?: string;
  status: string;
  source: SourceRef;
  createdAt: string;
  updatedAt: string;
  /** Server-side version of the decision-relevant snapshot; required to submit. */
  decisionVersion?: string;
  decision?: DecisionResult;
  jev?: DecisionResult;
  priority?: number;
  priorityBreakdown?: PriorityBreakdown;
  reason: string;
  diff?: string;
  suggestedAction?: string;
  deferredUntil?: string;
  seenCount?: number;
  lastSeenAt?: string;
  sources?: SourceRef[];
  suggestion?: Suggestion;
  suggestionState?: "pending" | "ready" | "failed";
  suggestionError?: string;
  turnID?: string;
  hookID?: string;
  origin?: "turn" | "session-review";
  reviewType?: ReviewType;
  evidence?: ReviewEvidence[];
  reviewID?: string;
  /** Derived at read time from curated L0/L2 files; never part of decisionVersion. */
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

export type HookStatus =
  | "pending"
  | "blocked"
  | "processing"
  | "auto"
  | "shadow"
  | "queue"
  | "ignored"
  | "failed";

export interface HookRecord {
  id: string;
  key: string;
  sessionID: string;
  turnID: string;
  messageID: string;
  text: string;
  title: string;
  trigger: string;
  scope: string;
  project?: string;
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

export interface SkillDraft {
  id: string;
  name: string;
  description: string;
  status: string;
  path: string;
  content?: string;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  testResult?: { ok: boolean; notes: string };
  createdAt: string;
  updatedAt: string;
}

export interface AuditFinding {
  id: string;
  severity: string;
  kind: string;
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

export interface MapNode {
  id: string;
  title: string;
  kind: string;
  scope: string;
  status: string;
  x: number;
  y: number;
  priority?: number;
}

export interface MapEdge {
  source: string;
  target: string;
  relation: string;
  score: number;
}

export interface MapData {
  nodes: MapNode[];
  edges: MapEdge[];
  generatedAt: string;
}

export type MemoryGraphView =
  | "architecture"
  | "inventory"
  | "routing"
  | "automation"
  | "backup"
  | "similarity";

export type MemoryGraphState =
  | "ready"
  | "disabled"
  | "missing"
  | "unreadable"
  | "partial"
  | "stale"
  | "unknown";

export interface GraphSource {
  id: string;
  layer: "L0" | "L1" | "L2" | "L3" | "OpenMem" | "LogicChain" | "Backup";
  label: string;
  path?: string;
  scope: "global" | "project" | "session" | "mixed" | "unknown";
  authority: "authoritative" | "derived" | "tentative" | "unknown";
  state: MemoryGraphState;
  files?: number;
  entries?: number;
  bytes?: number;
  updatedAt?: string;
  note?: string;
}

export interface GraphNode {
  id: string;
  view: Exclude<MemoryGraphView, "similarity">;
  kind: string;
  title: string;
  layer?: string;
  scope?: string;
  status?: string;
  sourceId?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  label?: string;
}

export interface GraphViewData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: Record<string, string | number | boolean>;
}

export interface MemoryGraphData {
  generatedAt: string;
  project?: { label: string; key: string };
  sources: GraphSource[];
  views: Record<Exclude<MemoryGraphView, "similarity">, GraphViewData>;
  groups?: GraphGroup[];
  backup?: BackupStatusView;
}

export type BackupIntegrity = "verified" | "partial" | "corrupt" | "unknown";
export type BackupFreshness = "fresh" | "stale" | "unknown";
export type RestoreSupport = "automatic" | "manual" | "none" | "unknown";

export interface BackupDomainView {
  id: string;
  label: string;
  required: string[];
  present: string[];
  missing: string[];
  state: "present" | "missing" | "unknown";
  integrity: BackupIntegrity;
  freshness: BackupFreshness;
  restoreSupport: RestoreSupport;
  notes: string[];
}

export interface BackupCoverageView {
  required: number;
  present: number;
  missing: string[];
  unknown: string[];
}

export interface BackupSnapshotView {
  dir: string;
  name: string;
  createdAt?: string;
  complete: boolean | "unknown";
  integrity: BackupIntegrity;
  freshness: BackupFreshness;
  manifestPresent: boolean;
  domains: BackupDomainView[];
  coverage: BackupCoverageView;
  notes: string[];
}

export interface BackupStatusView {
  latest?: BackupSnapshotView;
  latestComplete?: BackupSnapshotView;
  snapshotPresent: boolean;
  integrity: BackupIntegrity;
  freshness: BackupFreshness;
  restoreSupport: RestoreSupport;
  restoreDrill?: {
    at: string;
    softwareVersion?: string;
    snapshotID?: string;
    result: "passed" | "failed";
  };
  drillStatus: "passed" | "failed" | "missing" | "invalid";
  coverage: BackupCoverageView;
  domains: BackupDomainView[];
  manifestPresent: boolean;
  notes: string[];
}

export interface GraphGroup {
  id: string;
  relation: "exact" | "covered" | "classification-mismatch" | "conflict";
  title: string;
  nodeIds: string[];
}

export interface GraphSourceDetail {
  id: string;
  label: string;
  path: string;
  state: MemoryGraphState;
  headings: string[];
  excerpt: string;
  truncated: boolean;
  files?: Array<{ name: string; bytes: number }>;
}

export interface Config {
  version: number;
  shadow: boolean;
  autoMemory: boolean;
  autoRules: boolean;
  dataDir?: string;
  console?: boolean;
  port?: number;
  decision: {
    kind: "systemone" | "heuristic";
    endpoint: string;
    model: string;
    apiKeyEnv: string;
    timeoutMs: number;
    maxCallsPerHour: number;
    cacheTtlHours: number;
  };
  rewrite: {
    enabled: boolean;
    transport: "opencode" | "ollama";
    model: { providerID: string; id: string; variant?: string };
    endpoint: string;
    timeoutMs: number;
    maxCallsPerHour: number;
    repairAttempts: number;
    eager: boolean;
    cacheTtlHours: number;
  };
  review: {
    enabled: boolean;
    idleMs: number;
    minNewUserMessages: number;
    checkpointMessages: number;
    maxInputChars: number;
    maxUserCharsPerMessage: number;
    maxCandidates: number;
    minConfidence: number;
    maxPerHour: number;
    transcript: "user" | "user+tools";
    redact: boolean;
    timeoutMs: number;
    repairAttempts: number;
    cacheTtlHours: number;
    model: { providerID: string; id: string; variant?: string };
    maxDeferrals: number;
  };
  digest: {
    maxEntries: number;
    maxBytes: number;
    maxChars: number;
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
    hooks?: number;
    reviews?: number;
    diskBytes: number;
  };
}

/** Server-owned project identity for this console instance. */
export interface ProjectContext {
  key: string;
  label: string;
}

export interface Health {
  ok: boolean;
  version: string;
  dataDir: string;
  shadow: boolean;
  /** Absent when the console was started without a project context. */
  project?: ProjectContext | null;
  decision: {
    kind: string;
    model: string;
    endpoint: string;
    keySource: "env" | "auth" | "missing";
  };
  rewrite: {
    enabled: boolean;
    transport: string;
    model: { providerID: string; id: string; variant?: string };
  };
  review?: {
    enabled: boolean;
    model: { providerID: string; id: string; variant?: string };
    idleMs: number;
    transcript: string;
    maxPerHour: number;
    runtime: {
      scheduled?: number;
      running?: number;
      runsLastHour?: number;
      paused?: boolean;
      lastRunAt?: string;
      lastError?: string;
      failures?: number;
      openUntil?: number;
      cached?: number;
    } | null;
  };
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

export interface MergeSnapshot {
  id?: string;
  title: string;
  text: string;
}

/**
 * Mirrors the journal the server actually writes. `before.target`, `after.target`
 * and `after.item` are full snapshots used by the server to validate an undo;
 * older journals may lack them, so consumers must treat every snapshot as
 * optional and never reconstruct content from ids or titles.
 */
export interface MergeJournal {
  id: string;
  at: string;
  action: MergeAction;
  queueID: string;
  targetID?: string;
  before: { target?: MergeSnapshot; queue: MergeSnapshot };
  after: { itemID?: string; targetText?: string; target?: MergeSnapshot; item?: MergeSnapshot };
  /** A started undo can safely resume after a crash between file writes. */
  undoing?: boolean;
  undone?: boolean;
}

/** One item as returned by GET /api/memory/items (P01 envelope). */
export interface MemoryItem {
  id: string;
  title: string;
  text: string;
  kind: "fact" | "preference" | "rule" | "reference" | "skill";
  scope: "session" | "project" | "global";
  project?: string;
  projectKey?: string;
  expiresAt?: string;
  manual?: boolean;
  status: "auto" | "queue" | "shadow" | "promoted" | "false_positive" | "archived";
  source: SourceRef;
  sources?: SourceRef[];
  createdAt: string;
  updatedAt: string;
  origin?: "turn" | "session-review";
  reviewType?: ReviewType;
  evidence?: ReviewEvidence[];
  reviewID?: string;
  changeID?: string;
  invalidatedBy?: string;
  invalidatedAt?: string;
  supersededBy?: string;
  derivedFrom?: string[];
  /** Server-computed content version; the only value accepted by write APIs. */
  version: string;
  /** Server-computed capability flags; the UI never derives these locally. */
  stoppable: boolean;
  restorable: boolean;
  expired: boolean;
  revertible: boolean;
  /** Most recent change event for this item, when one is recorded. */
  latestChange?: ChangeEvent;
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

/** Full item snapshot recorded inside a change event (no derived fields). */
export type ItemSnapshot = Omit<
  MemoryItem,
  "version" | "stoppable" | "restorable" | "expired" | "revertible" | "latestChange"
>;

/** A read-only ledger event from GET /api/changes. */
export interface ChangeEvent {
  id: string;
  at: string;
  kind: ChangeKind;
  actor: ChangeActor;
  itemID: string;
  /** Post-change content version; absent when the item is gone. */
  itemVersion?: string;
  before?: ItemSnapshot;
  after?: ItemSnapshot;
  source: SourceRef;
  origin?: "turn" | "session-review" | "curator" | "migration" | "user";
  dependsOn?: string[];
  derivedFrom?: string[];
  linkGroupID?: string;
  reason: string;
  reverts?: string;
  revertible: boolean;
}

/** Result of POST /api/items/:id/{deactivate,reactivate,revert,restore}. */
export type RevertOutcome =
  | { ok: true; event: ChangeEvent; invalidated: string[] }
  | {
      ok: false;
      code: "not_found" | "version_mismatch" | "not_revertible" | "conflict";
      message: string;
      /** Current content version reported by a 409 response. */
      version?: string;
    };

/** One bounded recall hit from GET /api/recall. */
export interface RecallHit {
  id: string;
  version: string;
  title: string;
  text: string;
  scope: "session" | "project" | "global";
  kind: MemoryItem["kind"];
  /** Ordering feature sum, not a probability. */
  score: number;
  reasons: string[];
  numericConflict?: boolean;
  negationMismatch?: boolean;
}

export interface RecallResult {
  hits: RecallHit[];
  tokens: number;
  estimate: boolean;
  degraded?: { reason: "empty_query" | "store_error" | "budget" | "unlocated" };
}

export type AutomationMode = "off" | "shadow" | "autonomous";

export interface AutomationStatus {
  mode: AutomationMode | "legacy";
  configuredMode: AutomationMode | "legacy";
  effectiveMode: AutomationMode | "legacy";
  configRevision: string;
  revision: number;
  counts: {
    pending: number;
    running: number;
    delayed: number;
    expired: number;
    expiredPending: number;
    quarantined: number;
  };
  pending: {
    usedRows: number;
    maxRows: number;
    usedBytes: number;
    maxBytes: number;
    ttlMs: number;
    oldestAgeMs: number;
    expiredRows: number;
    pendingFull: number;
    capacityBlocked: boolean;
    capacityBlockedUntil: string | null;
    nextRetryAt: string | null;
    reasons: Record<string, number>;
  };
  ownership: {
    basis: string;
    currentValidation: string;
    cachedOwnerKnown: number;
    ownerUnknown: number;
    child: number;
    parentUnknown: number;
  };
  provider: {
    transport: string;
    providerID: string;
    runtimeProviderID: string;
    runtimeKnown: boolean;
    modelConfigured: boolean;
    review: unknown;
    extract: unknown;
  };
  availability: {
    extract: "configured" | "degraded" | "disabled" | "unknown";
    reviewProvider: string;
    extractProvider: string;
    externalReachability: string;
  };
  budget: {
    hourly: { used: number; limit: number; retryAt: string | null };
    daily: { used: number; limit: number; retryAt: string | null };
    purpose: { review: number; extract: number };
    extractFloor: {
      eligible: boolean;
      daily: number;
      hourly: number;
      usedDaily: number;
      remainingDaily: number;
      usedHourly: number;
      remainingHourly: number;
    };
  };
  lifecycle: Record<string, unknown>;
  capacity: {
    level: "ok" | "warn" | "compact" | "freeze" | "block";
    ratio: number;
    reason: string;
    historyAtCapacity: boolean;
    counts: {
      items: number;
      autoMemory: number;
      autoRules: number;
      queue: number;
      shadow: number;
      drafts: number;
      diskBytes: number;
      changes: number;
      changeJournals: number;
      suppressions: number;
      quarantine: number;
      retiredSources: number;
      globalCandidates: number;
      migrationJournals: number;
      checkpointBackups: number;
    };
  };
  retention: RetentionHistorySnapshot | null;
  blockedReasons: string[];
  degraded: Array<{
    scope: string;
    state: "disabled" | "blocked" | "degraded" | "unknown";
    reason: string;
    count?: number;
    retryAt?: string | null;
  }>;
  lastExtractAt: string | null;
  lastSuccess: { at: string; kind: string; action?: string } | null;
  lastMaintenanceAt: string | null;
  /** Server time this snapshot was produced; UI freshness uses this, not activity. */
  generatedAt?: string;
}

export interface RetentionHistorySnapshot {
  at: string;
  deleted: { changes: number; journals: number; suppressions: number; quarantine: number };
  reclaimedBytes: number;
  remainingReclaimableBytes: number;
  protected: { changes: number; journals: number; suppressions: number };
  blocked: boolean;
  blockedReasons: string[];
  notes: string[];
  nextAttemptAt?: string;
}

/** Read-only retention preview; contains ids/paths/counts, never content. */
export interface RetentionPreview {
  id: string;
  policy: { days: number; minRecords: number; sessionDays: number };
  retainDays: number;
  deleteFiles: string[];
  archiveSessions: string[];
  pruneItems: number;
  pruneMerges: number;
  pruneHistory: number;
  reclaimableBytes: number;
  reclaimable: {
    filesBytes: number;
    changesBytes: number;
    changeJournalBytes: number;
    suppressionBytes: number;
    quarantineBytes: number;
  };
  protectedCount: number;
  protectedChanges: number;
  protectedJournals: number;
  protectedSuppressions: number;
  pruneChanges: number;
  pruneChangeJournals: number;
  pruneSuppressions: number;
  pruneQuarantine: number;
  deletedChanges: string[];
  deletedChangeJournals: string[];
  deletedSuppressions: string[];
  deletedQuarantine: string[];
  counts: {
    changes: number;
    changeJournals: number;
    suppressions: number;
    quarantine: number;
    retiredSources: number;
    globalCandidates: number;
    migrationJournals: number;
    checkpointBackups: number;
  };
  historyBytes: number;
  blocked: boolean;
  blockedReasons: string[];
  notes: string[];
}

/** Read-only changelog entry as returned by GET /api/changelog. */
export interface ChangelogEntry {
  at: string;
  action: string;
  queueID?: string;
  itemID?: string;
  target?: string;
  journalID?: string;
  reviewID?: string;
  curatorID?: string;
  recoveryID?: string;
  source?: string;
  decision?: string;
  fields?: string[];
  humanEdited?: boolean;
  reason?: string;
  count?: number;
  reasons?: string[];
  sessionID?: string;
  messageID?: string;
}
