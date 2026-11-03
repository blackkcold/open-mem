export type ItemKind = "fact" | "preference" | "rule" | "reference" | "skill";
export type ItemStatus = "auto" | "queue" | "shadow" | "promoted" | "false_positive" | "archived";
export type Scope = "global" | "project";
export type MergeAction = "create" | "merge_into" | "replace" | "keep_both" | "reject_duplicate";

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
  source: "systemone" | "heuristic" | "jev";
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
  model?: { providerID: string; id: string };
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  createdAt: string;
}

export interface QueueItem extends Item {
  reason: string;
  diff?: string;
  suggestedAction?: "approve" | "deny" | "edit" | "defer" | "merge";
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
  wouldWriteTo: string;
  wouldApply: number;
  decision?: DecisionResult;
  /** @deprecated Old field name. */
  jev?: JevResult;
  priority: number;
  source: SourceRef;
  createdAt: string;
  falsePositive?: boolean;
  falsePositiveAt?: string;
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
}

export interface RewriteConfig {
  enabled: boolean;
  transport: "opencode" | "ollama";
  model: { providerID: string; id: string };
  endpoint: string;
  timeoutMs: number;
  maxCallsPerHour: number;
  repairAttempts: number;
  eager: boolean;
  cacheTtlHours: number;
}

export interface AutoMemConfig {
  version: 1;
  shadow: boolean;
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
    diskBytes: number;
  };
}

export interface AutopilotContext {
  version: 1;
  autoMemory: string[];
  autoRules: string[];
  queueCount: number;
  auditSummary?: string;
  shadow: boolean;
}

export interface SessionMessage {
  id?: string;
  type?: string;
  role?: string;
  text?: string;
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
  after: { itemID?: string; targetText?: string };
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
