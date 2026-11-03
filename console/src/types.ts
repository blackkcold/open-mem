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
  model?: { providerID: string; id: string };
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  createdAt: string;
}

export interface QueueItem {
  id: string;
  title: string;
  text: string;
  kind: string;
  scope: string;
  project?: string;
  status: string;
  source: SourceRef;
  createdAt: string;
  updatedAt: string;
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
    model: { providerID: string; id: string };
    endpoint: string;
    timeoutMs: number;
    maxCallsPerHour: number;
    repairAttempts: number;
    eager: boolean;
    cacheTtlHours: number;
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
    model: { providerID: string; id: string };
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
  before: { target?: { title: string; text: string }; queue: QueueItem };
  after: { itemID?: string; targetText?: string };
  undone?: boolean;
}
