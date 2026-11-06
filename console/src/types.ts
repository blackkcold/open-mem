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
  }>;
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

export interface Health {
  ok: boolean;
  version: string;
  dataDir: string;
  shadow: boolean;
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
