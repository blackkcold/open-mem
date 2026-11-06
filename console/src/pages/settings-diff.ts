import type { Config } from "../types";

/**
 * The server adds an opaque revision next to the public config. It is kept
 * outside the form value and the dirty JSON so a revision-only refresh never
 * makes the form look edited.
 */
export type ConfigWithRevision = Config & {
  configRevision?: unknown;
  persistedSettings?: unknown;
};

export function readConfigRevision(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function configWithoutRevision(response: ConfigWithRevision): Config {
  const {
    configRevision: _configRevision,
    persistedSettings: _persistedSettings,
    ...config
  } = response;
  return config;
}

/**
 * Only fields the Settings form can edit. Nested groups are partial so a save
 * never replaces a whole object or deletes fields it does not own.
 */
export interface SettingsPatch {
  shadow?: boolean;
  autoMemory?: boolean;
  decision?: Partial<Config["decision"]>;
  rewrite?: Partial<Omit<Config["rewrite"], "model">> & {
    model?: Partial<Config["rewrite"]["model"]>;
  };
  review?: Partial<Omit<Config["review"], "model">> & {
    model?: Partial<Config["review"]["model"]>;
  };
  thresholds?: Partial<Config["thresholds"]>;
  caps?: Partial<Config["caps"]>;
}

const DECISION_KEYS = [
  "kind",
  "endpoint",
  "model",
  "apiKeyEnv",
  "timeoutMs",
  "maxCallsPerHour",
  "cacheTtlHours",
] as const;

const REWRITE_KEYS = [
  "enabled",
  "transport",
  "eager",
  "timeoutMs",
  "maxCallsPerHour",
  "repairAttempts",
] as const;

const REVIEW_KEYS = [
  "enabled",
  "idleMs",
  "maxPerHour",
  "maxCandidates",
  "transcript",
  "redact",
] as const;

const MODEL_KEYS = ["providerID", "id", "variant"] as const;

const THRESHOLD_KEYS = [
  "memoryMaxChars",
  "ruleMaxChars",
  "titleMaxChars",
  "autoOkMin",
  "globalAutoOkMin",
  "duplicateMax",
] as const;

const CAPS_KEYS = [
  "autoMemory",
  "autoRules",
  "queue",
  "shadow",
  "skillDrafts",
  "itemsTotal",
  "diskBytes",
] as const;

function pickChanged<T, K extends keyof T>(
  before: T,
  after: T,
  keys: readonly K[],
): Partial<Pick<T, K>> | undefined {
  const patch: Partial<Pick<T, K>> = {};
  let changed = false;
  for (const key of keys) {
    if (!Object.is(before[key], after[key])) {
      patch[key] = after[key];
      changed = true;
    }
  }
  return changed ? patch : undefined;
}

/**
 * Deep diff of editable fields only. Unedited fields, tokens, the schema
 * version, digest and canvas/read-only fields never enter the patch.
 */
export function settingsPatch(baseline: Config, draft: Config): SettingsPatch {
  const patch: SettingsPatch = {};
  if (!Object.is(baseline.shadow, draft.shadow)) patch.shadow = draft.shadow;
  if (!Object.is(baseline.autoMemory, draft.autoMemory)) {
    patch.autoMemory = draft.autoMemory;
  }

  const decision = pickChanged(baseline.decision, draft.decision, DECISION_KEYS);
  if (decision) patch.decision = decision;

  const rewrite = pickChanged(baseline.rewrite, draft.rewrite, REWRITE_KEYS);
  const rewriteModel = pickChanged(
    baseline.rewrite.model,
    draft.rewrite.model,
    MODEL_KEYS,
  );
  if (rewrite || rewriteModel) {
    patch.rewrite = { ...rewrite, ...(rewriteModel ? { model: rewriteModel } : {}) };
  }

  const review = pickChanged(baseline.review, draft.review, REVIEW_KEYS);
  const reviewModel = pickChanged(
    baseline.review.model,
    draft.review.model,
    MODEL_KEYS,
  );
  if (review || reviewModel) {
    patch.review = { ...review, ...(reviewModel ? { model: reviewModel } : {}) };
  }

  const thresholds = pickChanged(
    baseline.thresholds,
    draft.thresholds,
    THRESHOLD_KEYS,
  );
  if (thresholds) patch.thresholds = thresholds;

  const caps = pickChanged(baseline.caps, draft.caps, CAPS_KEYS);
  if (caps) patch.caps = caps;

  return patch;
}

export function isSettingsPatchEmpty(patch: SettingsPatch): boolean {
  return Object.keys(patch).length === 0;
}

export interface SettingsSavePlan {
  revision: string;
  patch: SettingsPatch;
}

export type SavePlanResult =
  | { ok: true; plan: SettingsSavePlan }
  | { ok: false; reason: "missing-baseline" | "missing-revision" | "no-changes" };

/**
 * A save always carries the revision of the accepted baseline. Missing or
 * invalid revisions fail closed instead of sending an unchecked overwrite.
 */
export function buildSavePlan(input: {
  baseline: Config | undefined;
  draft: Config;
  revision: string | null;
}): SavePlanResult {
  if (!input.baseline) return { ok: false, reason: "missing-baseline" };
  if (!input.revision) return { ok: false, reason: "missing-revision" };
  const patch = settingsPatch(input.baseline, input.draft);
  if (isSettingsPatchEmpty(patch)) return { ok: false, reason: "no-changes" };
  return { ok: true, plan: { revision: input.revision, patch } };
}

export type SettingsSaveBody = SettingsPatch & { expectedConfigRevision: string };

export function settingsSaveBody(plan: SettingsSavePlan): SettingsSaveBody {
  return { ...plan.patch, expectedConfigRevision: plan.revision };
}

/** True when a confirmation dialog still describes the exact request to send. */
export function sameSavePlan(a: SettingsSavePlan, b: SettingsSavePlan): boolean {
  return a.revision === b.revision && JSON.stringify(a.patch) === JSON.stringify(b.patch);
}

export type LoadedConfigDecision =
  | { kind: "stale" }
  | { kind: "invalid-revision" }
  | { kind: "baseline"; revision: string }
  | { kind: "concurrent"; revision: string }
  | { kind: "unchanged" };

/**
 * A background refresh may only replace the baseline when the form accepted
 * it. While the draft stays dirty, a different incoming revision is reported
 * but the accepted baseline revision is deliberately retained.
 */
export function evaluateLoadedConfig(input: {
  requestId: number;
  latestRequestId: number;
  applied: boolean;
  baselineRevision: string | null;
  incomingRevision: string | null;
}): LoadedConfigDecision {
  if (input.requestId !== input.latestRequestId) return { kind: "stale" };
  if (input.incomingRevision === null) return { kind: "invalid-revision" };
  if (input.applied) return { kind: "baseline", revision: input.incomingRevision };
  if (input.baselineRevision === null) return { kind: "unchanged" };
  if (input.baselineRevision !== input.incomingRevision) {
    return { kind: "concurrent", revision: input.incomingRevision };
  }
  return { kind: "unchanged" };
}

/** Every editable leaf, in the same shape the server uses for metadata keys. */
export const SETTINGS_FIELD_PATHS: readonly string[] = [
  "shadow",
  "autoMemory",
  ...DECISION_KEYS.map((key) => `decision.${key}`),
  ...REWRITE_KEYS.map((key) => `rewrite.${key}`),
  ...MODEL_KEYS.map((key) => `rewrite.model.${key}`),
  ...REVIEW_KEYS.map((key) => `review.${key}`),
  ...MODEL_KEYS.map((key) => `review.model.${key}`),
  ...THRESHOLD_KEYS.map((key) => `thresholds.${key}`),
  ...CAPS_KEYS.map((key) => `caps.${key}`),
];

const OPTIONAL_VARIANT_PATHS = new Set([
  "rewrite.model.variant",
  "review.model.variant",
]);

export type SettingValue = string | number | boolean | null;

export function isSettingValue(value: unknown): value is SettingValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export interface PersistedSetting {
  value: SettingValue;
  differsFromLive: boolean;
}

export type PersistedSettings = Record<string, PersistedSetting>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Read a canonical editable leaf. An absent optional variant is legitimately
 * "no value" (null); other absent fields are invalid.
 */
export function readSettingsField(
  root: unknown,
  path: string,
): SettingValue | undefined {
  const value = readPath(root, path);
  if (value === undefined && OPTIONAL_VARIANT_PATHS.has(path)) return null;
  return isSettingValue(value) ? value : undefined;
}

function metadataValueMatches(
  path: string,
  live: SettingValue | undefined,
  value: SettingValue,
): boolean {
  // The backend masks/withholds suspicious endpoints; null means hidden or
  // unavailable, not an empty disk value.
  if (path === "decision.endpoint") return typeof value === "string" || value === null;
  if (OPTIONAL_VARIANT_PATHS.has(path)) {
    return typeof value === "string" || value === null;
  }
  if (live === undefined || live === null) return false;
  if (typeof live === "boolean") return typeof value === "boolean";
  if (typeof live === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (typeof live === "string") return typeof value === "string";
  return false;
}

/**
 * Validate the server's persistedSettings snapshot. Partial, forged or
 * wrongly typed metadata returns null so the caller can fail closed.
 */
export function readPersistedSettings(
  raw: unknown,
  baseline: Config,
): PersistedSettings | null {
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).length !== SETTINGS_FIELD_PATHS.length) return null;
  const parsed: PersistedSettings = {};
  for (const path of SETTINGS_FIELD_PATHS) {
    if (!Object.hasOwn(raw, path)) return null;
    const entry = raw[path];
    if (!isRecord(entry)) return null;
    const keys = Object.keys(entry);
    if (
      keys.length !== 2 ||
      !keys.includes("value") ||
      !keys.includes("differsFromLive")
    ) {
      return null;
    }
    if (typeof entry.differsFromLive !== "boolean") return null;
    if (!isSettingValue(entry.value)) return null;
    const live = readSettingsField(baseline, path);
    if (!metadataValueMatches(path, live, entry.value)) return null;
    parsed[path] = {
      value: entry.value,
      differsFromLive: entry.differsFromLive,
    };
  }
  return parsed;
}

export interface ConfigSnapshot {
  config: Config;
  revision: string | null;
  persistedSettings: PersistedSettings | null;
}

/** Bind config, revision and metadata from one response. */
export function readConfigSnapshot(
  response: ConfigWithRevision,
): ConfigSnapshot {
  const config = configWithoutRevision(response);
  return {
    config,
    revision: readConfigRevision(response.configRevision),
    persistedSettings: readPersistedSettings(response.persistedSettings, config),
  };
}

export interface SettingsPatchLeaf {
  path: string;
  value: SettingValue;
}

export function settingsPatchLeaves(
  patch: SettingsPatch,
): SettingsPatchLeaf[] {
  const leaves: SettingsPatchLeaf[] = [];
  for (const path of SETTINGS_FIELD_PATHS) {
    const value = readPath(patch, path);
    if (isSettingValue(value)) leaves.push({ path, value });
  }
  return leaves;
}

export interface SettingsOverwriteEntry {
  path: string;
  live: SettingValue;
  disk: SettingValue;
  proposed: SettingValue;
}

export type SettingsOverwritePreview =
  | { ok: true; entries: SettingsOverwriteEntry[] }
  | {
      ok: false;
      reason: "missing-metadata" | "missing-field" | "invalid-baseline";
      paths: string[];
    };

/**
 * Only changed fields whose accepted metadata says disk and live differ are
 * previewed. Hidden endpoint values are represented by null and are displayed
 * honestly; they are never treated as an empty disk value.
 */
export function buildSettingsOverwritePreview(input: {
  baseline: Config;
  patch: SettingsPatch;
  persistedSettings: PersistedSettings | null;
}): SettingsOverwritePreview {
  const leaves = settingsPatchLeaves(input.patch);
  if (!input.persistedSettings) {
    return {
      ok: false,
      reason: "missing-metadata",
      paths: leaves.map((leaf) => leaf.path),
    };
  }
  const missing: string[] = [];
  const entries: SettingsOverwriteEntry[] = [];
  for (const leaf of leaves) {
    if (!Object.hasOwn(input.persistedSettings, leaf.path)) {
      missing.push(leaf.path);
      continue;
    }
    const metadata = input.persistedSettings[leaf.path];
    const live = readSettingsField(input.baseline, leaf.path);
    if (live === undefined) {
      return { ok: false, reason: "invalid-baseline", paths: [leaf.path] };
    }
    if (live === null && !OPTIONAL_VARIANT_PATHS.has(leaf.path)) {
      return { ok: false, reason: "invalid-baseline", paths: [leaf.path] };
    }
    if (metadata.differsFromLive) {
      entries.push({
        path: leaf.path,
        live,
        disk: metadata.value,
        proposed: leaf.value,
      });
    }
  }
  if (missing.length > 0) {
    return { ok: false, reason: "missing-field", paths: missing };
  }
  return { ok: true, entries };
}

const HIDDEN_ENDPOINT_LABEL = "已隐藏或不可用";

/** Mask userinfo, query and hash for display only; the raw patch is untouched. */
export function maskEndpointForDisplay(value: string): string {
  let masked = value.replace(/\/\/[^/?#@]*@/, "//***@");
  masked = masked.replace(/^[^/?#@]*@/, "***@");
  const hashIndex = masked.indexOf("#");
  if (hashIndex >= 0) masked = `${masked.slice(0, hashIndex)}#***`;
  const queryIndex = masked.indexOf("?");
  if (queryIndex >= 0) {
    const nextHash = masked.indexOf("#");
    masked =
      nextHash >= 0
        ? `${masked.slice(0, queryIndex)}?***${masked.slice(nextHash)}`
        : `${masked.slice(0, queryIndex)}?***`;
  }
  return masked;
}

export function formatSettingsDisplayValue(
  path: string,
  value: SettingValue,
): string {
  if (value === null) {
    return path === "decision.endpoint" ? HIDDEN_ENDPOINT_LABEL : "（无）";
  }
  if (typeof value === "string") {
    if (value === "") return "（空）";
    return path === "decision.endpoint" ? maskEndpointForDisplay(value) : value;
  }
  return String(value);
}

export function formatSettingsOverwritePreview(
  entries: readonly SettingsOverwriteEntry[],
): string {
  return entries
    .map((entry) =>
      [
        `字段：${entry.path}`,
        `  live（当前生效）：${formatSettingsDisplayValue(entry.path, entry.live)}`,
        `  disk（磁盘已保存）：${formatSettingsDisplayValue(entry.path, entry.disk)}`,
        `  本次保存：${formatSettingsDisplayValue(entry.path, entry.proposed)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export interface SettingsSaveConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
}

/**
 * One dialog can carry both the shadow warning and the overwrite preview.
 * Neither warning is dropped when both are needed.
 */
export function settingsSaveConfirmation(input: {
  shadowOff: boolean;
  entries: readonly SettingsOverwriteEntry[];
}): SettingsSaveConfirmation | null {
  const hasPreview = input.entries.length > 0;
  if (!input.shadowOff && !hasPreview) return null;
  const parts: string[] = [];
  if (input.shadowOff) {
    parts.push(
      "关闭 Shadow 后，符合条件的事实和偏好会写入长期记忆；规则仍需人工确认。",
    );
  }
  if (hasPreview) {
    parts.push(
      `以下字段的 live 值与磁盘保存值不同，本次保存会写入你的拟保存值：\n\n${formatSettingsOverwritePreview(input.entries)}`,
    );
  }
  return {
    title: hasPreview ? "确认保存并覆盖磁盘差异？" : "开启真实自动写入？",
    message: parts.join("\n\n"),
    confirmLabel: hasPreview ? "确认并保存" : "开启自动写入",
    danger: hasPreview,
  };
}

export interface SettingsSaveIntent {
  plan: SettingsSavePlan;
  baseline: string;
  draft: string;
  metadata: string;
}

export function settingsSaveIntent(
  plan: SettingsSavePlan,
  baseline: Config,
  draft: Config,
  metadata: PersistedSettings,
): SettingsSaveIntent {
  return {
    plan,
    baseline: JSON.stringify(baseline),
    draft: JSON.stringify(draft),
    metadata: settingsMetadataSignature(metadata),
  };
}

export function settingsMetadataSignature(
  metadata: PersistedSettings,
): string {
  return JSON.stringify(
    SETTINGS_FIELD_PATHS.map((path) => {
      const entry = metadata[path];
      return [path, entry.value, entry.differsFromLive];
    }),
  );
}

export function sameSaveIntent(
  a: SettingsSaveIntent,
  b: SettingsSaveIntent,
): boolean {
  return (
    a.baseline === b.baseline &&
    a.draft === b.draft &&
    a.metadata === b.metadata &&
    sameSavePlan(a.plan, b.plan)
  );
}

export function isConfigRevisionConflict(status: number): boolean {
  return status === 409;
}
