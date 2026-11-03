import type {
  AutoMemConfig,
  DecisionConfig,
  RewriteConfig,
  Scope,
} from "./types.js";

export const DEFAULT_CONFIG: AutoMemConfig = {
  version: 1,
  shadow: true,
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
  },
  rewrite: {
    enabled: true,
    transport: "opencode",
    model: { providerID: "ollama-cloud", id: "glm-5.3-flash:cloud" },
    endpoint: "https://ollama.com",
    timeoutMs: 25_000,
    maxCallsPerHour: 20,
    repairAttempts: 1,
    eager: true,
    cacheTtlHours: 72,
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
    diskBytes: 20 * 1024 * 1024,
  },
};

export type ConfigPatch = Omit<
  Partial<AutoMemConfig>,
  "decision" | "rewrite" | "thresholds" | "caps"
> & {
  decision?: Partial<DecisionConfig>;
  rewrite?: Partial<Omit<RewriteConfig, "model">> & {
    model?: { providerID?: string; id?: string };
  };
  thresholds?: Partial<AutoMemConfig["thresholds"]>;
  caps?: Partial<AutoMemConfig["caps"]>;
};

export function mergeConfig(...parts: Array<ConfigPatch | undefined>): AutoMemConfig {
  const result: AutoMemConfig = structuredClone(DEFAULT_CONFIG);
  for (const part of parts) {
    if (!part) continue;
    const { decision, rewrite, thresholds, caps, ...rest } = part;
    const defined = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    );
    Object.assign(result, defined);
    if (thresholds) result.thresholds = { ...result.thresholds, ...thresholds };
    if (caps) result.caps = { ...result.caps, ...caps };
    if (decision) result.decision = { ...result.decision, ...decision };
    if (rewrite) {
      result.rewrite = {
        ...result.rewrite,
        ...rewrite,
        model: {
          providerID: rewrite.model?.providerID ?? result.rewrite.model.providerID,
          id: rewrite.model?.id ?? result.rewrite.model.id,
        },
      };
    }
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
