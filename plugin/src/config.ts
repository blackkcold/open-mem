import type {
  AutoMemConfig,
  AutomationConfig,
  DecisionConfig,
  DigestConfig,
  RecallConfig,
  ReviewConfig,
  RewriteConfig,
  Scope,
} from "./types.js";

export const DEFAULT_CONFIG: AutoMemConfig = {
  version: 1,
  shadow: true,
  shadowRecordAll: true,
  autoMemory: true,
  autoRules: true,
  console: true,
  port: 47821,
  decision: {
    kind: "systemone",
    endpoint: "https://ollama.com/v1/systemone",
    model: "clef:27b-cloud",
    apiKeyEnv: "OLLAMA_API_KEY",
    timeoutMs: 12_000,
    maxCallsPerHour: 30,
    cacheTtlHours: 24,
    queueMin: 0.72,
    queueMinRule: 0.8,
  },
  turn: {
    maxCandidates: 12,
    parallel: 3,
  },
  rewrite: {
    enabled: true,
    transport: "opencode",
    model: {
      providerID: "ollama-cloud",
      id: "deepseek-v4.1-flash:1017",
      variant: "high",
    },
    endpoint: "https://ollama.com",
    timeoutMs: 25_000,
    maxCallsPerHour: 20,
    repairAttempts: 1,
    eager: true,
    cacheTtlHours: 72,
  },
  review: {
    enabled: true,
    transport: "ollama",
    idleMs: 180_000,
    minNewUserMessages: 1,
    checkpointMessages: 20,
    maxInputChars: 12_000,
    maxUserCharsPerMessage: 800,
    maxCandidates: 8,
    minConfidence: 0.72,
    maxPerHour: 8,
    maxOutputTokens: 1500,
    transcript: "user+tools",
    redact: true,
    timeoutMs: 30_000,
    repairAttempts: 1,
    cacheTtlHours: 72,
    model: {
      providerID: "ollama-cloud",
      id: "deepseek-v4.1-flash:1017",
      variant: "high",
    },
    maxDeferrals: 3,
  },
  automation: {
    enabled: false,
    mode: "off",
    revision: 0,
    autoUpdate: true,
    dailyWrites: 40,
    maxWritesPerSession: 5,
  },
  recall: {
    limit: 5,
    tokenBudget: 600,
    apiLimit: 8,
    apiTokenBudget: 1200,
  },
  digest: {
    maxEntries: 2000,
    maxBytes: 2 * 1024 * 1024,
    maxChars: 160,
  },
  undo: {
    retainDays: 90,
  },
  thresholds: {
    memoryMaxChars: 200,
    ruleMaxChars: 160,
    titleMaxChars: 30,
    autoOkMin: 0.88,
    globalAutoOkMin: 0.92,
    duplicateMax: 0.2,
  },
  caps: {
    autoMemory: 100,
    autoRules: 50,
    queue: 50,
    shadow: 500,
    skillDrafts: 5,
    itemsTotal: 500,
    suggestions: 500,
    hooks: 2000,
    reviews: 500,
    diskBytes: 20 * 1024 * 1024,
  },
};

export type ConfigPatch = Omit<
  Partial<AutoMemConfig>,
  "decision" | "rewrite" | "thresholds" | "caps" | "turn" | "review" | "digest" | "undo" | "automation" | "recall"
> & {
  decision?: Partial<DecisionConfig>;
  rewrite?: Partial<Omit<RewriteConfig, "model">> & {
    model?: { providerID?: string; id?: string; variant?: string };
  };
  review?: Partial<Omit<ReviewConfig, "model">> & {
    model?: { providerID?: string; id?: string; variant?: string };
  };
  digest?: Partial<DigestConfig>;
  thresholds?: Partial<AutoMemConfig["thresholds"]>;
  caps?: Partial<AutoMemConfig["caps"]>;
  turn?: Partial<AutoMemConfig["turn"]>;
  undo?: Partial<AutoMemConfig["undo"]>;
  automation?: Partial<AutomationConfig>;
  recall?: Partial<RecallConfig>;
};

export function mergeConfig(...parts: Array<ConfigPatch | undefined>): AutoMemConfig {
  const result: AutoMemConfig = structuredClone(DEFAULT_CONFIG);
  for (const part of parts) {
    if (!part) continue;
    const { decision, rewrite, review, digest, thresholds, caps, turn, undo, automation, recall, ...rest } = part;
    const defined = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    );
    Object.assign(result, defined);
    if (thresholds) result.thresholds = { ...result.thresholds, ...thresholds };
    if (caps) result.caps = { ...result.caps, ...caps };
    if (turn) result.turn = { ...result.turn, ...turn };
    if (undo) result.undo = { ...result.undo, ...undo };
    if (automation) result.automation = { ...result.automation, ...automation };
    if (recall) result.recall = { ...result.recall, ...recall };
    if (decision) result.decision = { ...result.decision, ...decision };
    if (digest) result.digest = { ...result.digest, ...digest };
    if (review) {
      result.review = {
        ...result.review,
        ...review,
        model: {
          providerID: review.model?.providerID ?? result.review.model.providerID,
          id: review.model?.id ?? result.review.model.id,
          variant: review.model?.variant ?? result.review.model.variant,
        },
      };
    }
    if (rewrite) {
      result.rewrite = {
        ...result.rewrite,
        ...rewrite,
        model: {
          providerID: rewrite.model?.providerID ?? result.rewrite.model.providerID,
          id: rewrite.model?.id ?? result.rewrite.model.id,
          variant: rewrite.model?.variant ?? result.rewrite.model.variant,
        },
      };
    }
  }
  // A persisted pre-mode config is legacy state, not an implicit opt-in to
  // the new kill-switch semantics. Fresh stores use DEFAULT_CONFIG (mode=off);
  // only an explicit stored/API mode selects one of the new modes.
  const baseAutomation = parts[0]?.automation;
  if (!baseAutomation || typeof baseAutomation.mode !== "string") {
    result.automation.mode = undefined;
  }
  return result;
}

export function autoThreshold(config: AutoMemConfig, scope: Scope): number {
  return scope === "global"
    ? config.thresholds.globalAutoOkMin
    : config.thresholds.autoOkMin;
}

export function decisionOf<T extends { decision?: unknown; jev?: unknown }>(
  record: T,
): T["decision"] | T["jev"] | undefined {
  return (record.decision ?? record.jev) as T["decision"] | T["jev"] | undefined;
}
