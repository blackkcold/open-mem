import { describe, expect, it } from "vitest";
import type { Config } from "../../console/src/types";
import {
  SETTINGS_FIELD_PATHS,
  buildSavePlan,
  buildSettingsOverwritePreview,
  configWithoutRevision,
  evaluateLoadedConfig,
  formatSettingsOverwritePreview,
  isConfigRevisionConflict,
  isSettingsPatchEmpty,
  readConfigRevision,
  readConfigSnapshot,
  readPersistedSettings,
  readSettingsField,
  sameSaveIntent,
  sameSavePlan,
  settingsPatch,
  settingsPatchLeaves,
  settingsSaveBody,
  settingsSaveConfirmation,
  settingsSaveIntent,
} from "../../console/src/pages/settings-diff";
import type { PersistedSetting, PersistedSettings } from "../../console/src/pages/settings-diff";

function baseConfig(): Config {
  return {
    version: 1,
    shadow: true,
    autoMemory: false,
    autoRules: false,
    dataDir: "/tmp/openmem",
    console: true,
    port: 47821,
    decision: {
      kind: "systemone",
      endpoint: "http://127.0.0.1:11434",
      model: "clef:27b-cloud",
      apiKeyEnv: "OLLAMA_API_KEY",
      timeoutMs: 2000,
      maxCallsPerHour: 30,
      cacheTtlHours: 1,
    },
    rewrite: {
      enabled: true,
      transport: "opencode",
      model: { providerID: "opencode", id: "rewrite-model", variant: "high" },
      endpoint: "http://127.0.0.1:11434",
      timeoutMs: 3000,
      maxCallsPerHour: 20,
      repairAttempts: 1,
      eager: true,
      cacheTtlHours: 2,
    },
    review: {
      enabled: false,
      idleMs: 300_000,
      minNewUserMessages: 2,
      checkpointMessages: 10,
      maxInputChars: 12_000,
      maxUserCharsPerMessage: 2000,
      maxCandidates: 5,
      minConfidence: 0.5,
      maxPerHour: 3,
      transcript: "user+tools",
      redact: true,
      timeoutMs: 4000,
      repairAttempts: 1,
      cacheTtlHours: 3,
      model: { providerID: "opencode", id: "review-model", variant: "max" },
      maxDeferrals: 3,
    },
    digest: { maxEntries: 20, maxBytes: 4096, maxChars: 2048 },
    thresholds: {
      memoryMaxChars: 500,
      ruleMaxChars: 300,
      titleMaxChars: 80,
      autoOkMin: 0.7,
      globalAutoOkMin: 0.75,
      duplicateMax: 0.85,
    },
    caps: {
      autoMemory: 100,
      autoRules: 50,
      queue: 200,
      shadow: 100,
      skillDrafts: 20,
      itemsTotal: 500,
      suggestions: 100,
      hooks: 10,
      reviews: 10,
      diskBytes: 1024 * 1024,
    },
  };
}

function copyConfig(base: Config): Config {
  return {
    ...base,
    decision: { ...base.decision },
    rewrite: { ...base.rewrite, model: { ...base.rewrite.model } },
    review: { ...base.review, model: { ...base.review.model } },
    digest: { ...base.digest },
    thresholds: { ...base.thresholds },
    caps: { ...base.caps },
  };
}

function planOf(result: ReturnType<typeof buildSavePlan>) {
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}`);
  return result.plan;
}

function entriesOf(result: ReturnType<typeof buildSettingsOverwritePreview>) {
  if (!result.ok) throw new Error(`expected preview entries, got ${result.reason}`);
  return result.entries;
}

function persistedFor(
  base: Config,
  overrides: Record<string, PersistedSetting> = {},
): PersistedSettings {
  const metadata: PersistedSettings = {};
  for (const path of SETTINGS_FIELD_PATHS) {
    const live = readSettingsField(base, path);
    if (live === undefined) throw new Error(`missing live value for ${path}`);
    metadata[path] = { value: live, differsFromLive: false };
  }
  return { ...metadata, ...overrides };
}

function allChanged(base: Config): Config {
  const draft = copyConfig(base);
  draft.shadow = !base.shadow;
  draft.autoMemory = !base.autoMemory;
  draft.decision.kind = base.decision.kind === "systemone" ? "heuristic" : "systemone";
  draft.decision.endpoint = "http://192.0.2.20:11434";
  draft.decision.model = "changed-decision-model";
  draft.decision.apiKeyEnv = "CHANGED_API_KEY";
  draft.decision.timeoutMs = 4321;
  draft.decision.maxCallsPerHour = 12;
  draft.decision.cacheTtlHours = 6;
  draft.rewrite.enabled = !base.rewrite.enabled;
  draft.rewrite.transport = base.rewrite.transport === "opencode" ? "ollama" : "opencode";
  draft.rewrite.eager = !base.rewrite.eager;
  draft.rewrite.timeoutMs = 4321;
  draft.rewrite.maxCallsPerHour = 12;
  draft.rewrite.repairAttempts = 3;
  draft.rewrite.model.providerID = "changed-rewrite-provider";
  draft.rewrite.model.id = "changed-rewrite-id";
  draft.rewrite.model.variant = "changed-rewrite-variant";
  draft.review.enabled = !base.review.enabled;
  draft.review.idleMs = 123_456;
  draft.review.maxPerHour = 12;
  draft.review.maxCandidates = 12;
  draft.review.transcript = base.review.transcript === "user+tools" ? "user" : "user+tools";
  draft.review.redact = !base.review.redact;
  draft.review.model.providerID = "changed-review-provider";
  draft.review.model.id = "changed-review-id";
  draft.review.model.variant = "changed-review-variant";
  draft.thresholds.memoryMaxChars = 4321;
  draft.thresholds.ruleMaxChars = 4321;
  draft.thresholds.titleMaxChars = 42;
  draft.thresholds.autoOkMin = 0.42;
  draft.thresholds.globalAutoOkMin = 0.42;
  draft.thresholds.duplicateMax = 0.42;
  draft.caps.autoMemory = 12;
  draft.caps.autoRules = 12;
  draft.caps.queue = 12;
  draft.caps.shadow = 12;
  draft.caps.skillDrafts = 12;
  draft.caps.itemsTotal = 42;
  draft.caps.diskBytes = 42;
  return draft;
}

describe("settings deep diff", () => {
  it("sends nothing when the draft matches the baseline", () => {
    const base = baseConfig();
    const press = settingsPatch(base, copyConfig(base));
    expect(press).toEqual({});
    expect(isSettingsPatchEmpty(press)).toBe(true);
  });

  it("sends only a changed top-level field", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.shadow = false;
    expect(settingsPatch(base, draft)).toEqual({ shadow: false });
  });

  it("sends only the changed decision leaf", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.decision.endpoint = "http://192.0.2.10:11434";
    expect(settingsPatch(base, draft)).toEqual({
      decision: { endpoint: "http://192.0.2.10:11434" },
    });
  });

  it("sends only the changed rewrite model leaf", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.rewrite.model.variant = "default";
    expect(settingsPatch(base, draft)).toEqual({
      rewrite: { model: { variant: "default" } },
    });
  });

  it("keeps review scalars and the review model in one narrow group", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.review.redact = false;
    draft.review.model.providerID = "ollama";
    expect(settingsPatch(base, draft)).toEqual({
      review: { redact: false, model: { providerID: "ollama" } },
    });
  });

  it("diffs thresholds and caps independently", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.thresholds.duplicateMax = 0.1;
    draft.caps.queue = 350;
    expect(settingsPatch(base, draft)).toEqual({
      thresholds: { duplicateMax: 0.1 },
      caps: { queue: 350 },
    });
  });

  it("diffs the editable autoRules capacity independently", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.caps.autoRules = 77;
    expect(settingsPatch(base, draft)).toEqual({ caps: { autoRules: 77 } });
  });

  it("never sends unedited, digest, token-shaped or read-only fields", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.version = 9;
    draft.dataDir = "/elsewhere";
    draft.console = false;
    draft.port = 1;
    draft.autoRules = true;
    draft.digest.maxBytes = 1;
    draft.rewrite.endpoint = "http://elsewhere";
    draft.rewrite.cacheTtlHours = 9;
    draft.review.timeoutMs = 9;
    draft.review.maxDeferrals = 9;
    draft.caps.suggestions = 9;
    draft.caps.hooks = 9;
    draft.caps.reviews = 9;

    expect(settingsPatch(base, draft)).toEqual({});
  });

  it("returns an empty diff after a field is reverted to its baseline", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.review.maxCandidates = 9;
    expect(settingsPatch(base, draft)).toEqual({ review: { maxCandidates: 9 } });
    draft.review.maxCandidates = base.review.maxCandidates;
    expect(settingsPatch(base, draft)).toEqual({});
  });
});

describe("settings save plan", () => {
  it("fails closed without a baseline", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.shadow = false;
    expect(buildSavePlan({ baseline: undefined, draft, revision: "rev-1" })).toEqual({
      ok: false,
      reason: "missing-baseline",
    });
  });

  it("fails closed without a revision even when fields changed", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.shadow = false;
    expect(buildSavePlan({ baseline: base, draft, revision: null })).toEqual({
      ok: false,
      reason: "missing-revision",
    });
  });

  it("reports no changes instead of sending an empty patch", () => {
    const base = baseConfig();
    expect(
      buildSavePlan({ baseline: base, draft: copyConfig(base), revision: "rev-1" }),
    ).toEqual({ ok: false, reason: "no-changes" });
  });

  it("builds a patch plus the expected revision", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.autoMemory = true;
    const plan = planOf(buildSavePlan({ baseline: base, draft, revision: "rev-1" }));
    expect(plan.revision).toBe("rev-1");
    expect(plan.patch).toEqual({ autoMemory: true });

    const body = settingsSaveBody(plan);
    expect(body).toEqual({
      autoMemory: true,
      expectedConfigRevision: "rev-1",
    });
    expect(body).not.toHaveProperty("version");
    expect(body).not.toHaveProperty("digest");
    expect(body).not.toHaveProperty("autoRules");
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("dataDir");
  });

  it("matches the server GET response shape and PATCH body shape", () => {
    const base = baseConfig();
    // GET /api/config: public config plus a top-level revision string.
    const response = { ...copyConfig(base), configRevision: "sha16-abc" };
    const config = configWithoutRevision(response);
    const revision = readConfigRevision(response.configRevision);
    expect(revision).toBe("sha16-abc");

    const draft = copyConfig(config);
    draft.decision.model = "another-model";
    const plan = planOf(buildSavePlan({ baseline: config, draft, revision }));
    const body = settingsSaveBody(plan);

    expect(body).toEqual({
      decision: { model: "another-model" },
      expectedConfigRevision: "sha16-abc",
    });
    expect(body).not.toHaveProperty("configRevision");
    expect(body).not.toHaveProperty("dataDir");
  });
});

describe("config revision", () => {
  it("accepts only a non-empty revision string", () => {
    expect(readConfigRevision("rev-1")).toBe("rev-1");
    expect(readConfigRevision("")).toBeNull();
    expect(readConfigRevision("   ")).toBeNull();
    expect(readConfigRevision(null)).toBeNull();
    expect(readConfigRevision(undefined)).toBeNull();
    expect(readConfigRevision(7)).toBeNull();
    expect(readConfigRevision({ revision: "rev-1" })).toBeNull();
  });

  it("strips the revision from the form value and the dirty JSON", () => {
    const base = baseConfig();
    const first = configWithoutRevision({ ...copyConfig(base), configRevision: "rev-1" });
    const second = configWithoutRevision({ ...copyConfig(base), configRevision: "rev-2" });
    expect(first).not.toHaveProperty("configRevision");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("loaded config revision decisions", () => {
  const loaded = {
    requestId: 2,
    latestRequestId: 2,
    applied: false,
    baselineRevision: "rev-1",
    incomingRevision: "rev-2",
  };

  it("ignores a response from an older load request", () => {
    expect(evaluateLoadedConfig({ ...loaded, requestId: 1 })).toEqual({ kind: "stale" });
  });

  it("adopts a baseline when the form also accepted the config", () => {
    expect(evaluateLoadedConfig({ ...loaded, applied: true })).toEqual({
      kind: "baseline",
      revision: "rev-2",
    });
  });

  it("fails closed when the server sends no usable revision", () => {
    expect(evaluateLoadedConfig({ ...loaded, applied: true, incomingRevision: null })).toEqual({
      kind: "invalid-revision",
    });
  });

  it("flags a concurrent change while the draft stays dirty", () => {
    expect(evaluateLoadedConfig(loaded)).toEqual({ kind: "concurrent", revision: "rev-2" });
  });

  it("does not flag concurrency when the revision is unchanged", () => {
    expect(evaluateLoadedConfig({ ...loaded, incomingRevision: "rev-1" })).toEqual({
      kind: "unchanged",
    });
  });

  it("does not flag concurrency when there is no baseline revision yet", () => {
    expect(evaluateLoadedConfig({ ...loaded, baselineRevision: null })).toEqual({
      kind: "unchanged",
    });
  });

  it("keeps the old baseline revision for the next save after a concurrent notice", () => {
    const decision = evaluateLoadedConfig(loaded);
    expect(decision).toEqual({ kind: "concurrent", revision: "rev-2" });

    const base = baseConfig();
    const dirtyDraft = copyConfig(base);
    dirtyDraft.shadow = false;
    const plan = planOf(
      buildSavePlan({ baseline: base, draft: dirtyDraft, revision: "rev-1" }),
    );
    expect(plan.revision).toBe("rev-1");
    expect(plan.revision).not.toBe("rev-2");
  });
});

describe("shadow confirmation request identity", () => {
  it("matches when neither the draft nor the revision changed during confirmation", () => {
    const base = baseConfig();
    const shadowOff = copyConfig(base);
    shadowOff.shadow = false;
    const before = planOf(buildSavePlan({ baseline: base, draft: shadowOff, revision: "rev-1" }));
    const after = planOf(buildSavePlan({ baseline: base, draft: shadowOff, revision: "rev-1" }));
    expect(sameSavePlan(before, after)).toBe(true);
  });

  it("rejects the request when a field is edited during confirmation", () => {
    const base = baseConfig();
    const shadowOff = copyConfig(base);
    shadowOff.shadow = false;
    const before = planOf(buildSavePlan({ baseline: base, draft: shadowOff, revision: "rev-1" }));

    const edited = copyConfig(shadowOff);
    edited.decision.timeoutMs = 99;
    const after = planOf(buildSavePlan({ baseline: base, draft: edited, revision: "rev-1" }));
    expect(sameSavePlan(before, after)).toBe(false);
  });

  it("rejects the request when a load changes the revision during confirmation", () => {
    const base = baseConfig();
    const shadowOff = copyConfig(base);
    shadowOff.shadow = false;
    const before = planOf(buildSavePlan({ baseline: base, draft: shadowOff, revision: "rev-1" }));
    const after = planOf(buildSavePlan({ baseline: base, draft: shadowOff, revision: "rev-2" }));
    expect(sameSavePlan(before, after)).toBe(false);
  });

  it("rejects the request when a load changes the baseline fields during confirmation", () => {
    const base = baseConfig();
    const shadowOff = copyConfig(base);
    shadowOff.shadow = false;
    const before = planOf(buildSavePlan({ baseline: base, draft: shadowOff, revision: "rev-1" }));

    const movedBaseline = copyConfig(base);
    movedBaseline.decision.endpoint = "http://other";
    const after = planOf(
      buildSavePlan({ baseline: movedBaseline, draft: shadowOff, revision: "rev-1" }),
    );
    expect(sameSavePlan(before, after)).toBe(false);
  });
});

describe("settings field paths and persisted settings metadata", () => {
  it("covers every editable field exactly once", () => {
    expect(SETTINGS_FIELD_PATHS).toHaveLength(40);
    expect(new Set(SETTINGS_FIELD_PATHS).size).toBe(SETTINGS_FIELD_PATHS.length);
    expect(SETTINGS_FIELD_PATHS).toContain("shadow");
    expect(SETTINGS_FIELD_PATHS).toContain("caps.queue");
    expect(SETTINGS_FIELD_PATHS).toContain("rewrite.model.variant");
    expect(SETTINGS_FIELD_PATHS).toContain("review.model.variant");
    expect(SETTINGS_FIELD_PATHS).not.toContain("rewrite.endpoint");

    const base = baseConfig();
    const patch = settingsPatch(base, allChanged(base));
    expect(settingsPatchLeaves(patch).map((leaf) => leaf.path)).toEqual([
      ...SETTINGS_FIELD_PATHS,
    ]);
  });

  it("accepts a complete, correctly typed metadata snapshot", () => {
    const base = baseConfig();
    const metadata = persistedFor(base);
    expect(readPersistedSettings(metadata, base)).not.toBeNull();
    expect(Object.keys(metadata)).toHaveLength(SETTINGS_FIELD_PATHS.length);
  });

  it("strips revision and metadata from the form and dirty JSON", () => {
    const base = baseConfig();
    const response = {
      ...copyConfig(base),
      configRevision: "rev-1",
      persistedSettings: persistedFor(base),
    };
    const first = configWithoutRevision(response);
    const second = configWithoutRevision({
      ...response,
      configRevision: "rev-2",
      persistedSettings: persistedFor(base, {
        "caps.queue": { value: 1, differsFromLive: true },
      }),
    });
    expect(first).not.toHaveProperty("configRevision");
    expect(first).not.toHaveProperty("persistedSettings");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("accepts null variants and null hidden endpoints, but no other null values", () => {
    const base = baseConfig();
    const withHiddenEndpoint = {
      ...persistedFor(base),
      "decision.endpoint": { value: null, differsFromLive: true },
      "rewrite.model.variant": { value: null, differsFromLive: true },
      "review.model.variant": { value: null, differsFromLive: false },
    };
    const parsed = readPersistedSettings(withHiddenEndpoint, base);
    expect(parsed?.["decision.endpoint"]).toEqual({ value: null, differsFromLive: true });
    expect(parsed?.["rewrite.model.variant"]).toEqual({ value: null, differsFromLive: true });
    expect(parsed?.["review.model.variant"]).toEqual({ value: null, differsFromLive: false });

    for (const path of [
      "shadow",
      "caps.queue",
      "thresholds.autoOkMin",
      "decision.model",
      "decision.apiKeyEnv",
      "rewrite.model.id",
      "review.model.id",
    ]) {
      const bad = {
        ...persistedFor(base),
        [path]: { value: null, differsFromLive: true },
      };
      expect(readPersistedSettings(bad, base)).toBeNull();
    }
  });

  it("rejects missing, extra, wrongly typed and malformed entries", () => {
    const base = baseConfig();
    const missing = { ...persistedFor(base) } as Record<string, unknown>;
    delete missing["caps.queue"];
    expect(readPersistedSettings(missing, base)).toBeNull();

    expect(
      readPersistedSettings(
        { ...persistedFor(base), "caps.unknown": { value: 1, differsFromLive: false } },
        base,
      ),
    ).toBeNull();

    expect(
      readPersistedSettings(
        { ...persistedFor(base), "caps.queue": { value: "49", differsFromLive: true } },
        base,
      ),
    ).toBeNull();

    expect(
      readPersistedSettings(
        { ...persistedFor(base), "shadow": { value: true, differsFromLive: "no" } },
        base,
      ),
    ).toBeNull();

    expect(
      readPersistedSettings(
        {
          ...persistedFor(base),
          "caps.queue": { value: 49, differsFromLive: true, extra: 1 },
        },
        base,
      ),
    ).toBeNull();

    expect(readPersistedSettings(null, base)).toBeNull();
    expect(readPersistedSettings([], base)).toBeNull();
  });

  it("fails the whole snapshot when metadata is malformed, so save cannot proceed", () => {
    const base = baseConfig();
    const response = {
      ...copyConfig(base),
      configRevision: "rev-1",
      persistedSettings: {
        ...persistedFor(base),
        "caps.queue": { value: null, differsFromLive: true },
      },
    };
    expect(readConfigSnapshot(response).persistedSettings).toBeNull();
  });
});

describe("cross-instance same-field preview", () => {
  it("shows live 50, disk 49 and proposed 48 for a changed differing field", () => {
    const base = baseConfig();
    base.caps.queue = 50;
    const draft = copyConfig(base);
    draft.caps.queue = 48;
    const preview = buildSettingsOverwritePreview({
      baseline: base,
      patch: settingsPatch(base, draft),
      persistedSettings: persistedFor(base, {
        "caps.queue": { value: 49, differsFromLive: true },
      }),
    });
    const entries = entriesOf(preview);
    expect(entries).toEqual([
      { path: "caps.queue", live: 50, disk: 49, proposed: 48 },
    ]);
    const message = formatSettingsOverwritePreview(entries);
    expect(message).toContain("caps.queue");
    expect(message).toContain("50");
    expect(message).toContain("49");
    expect(message).toContain("48");
  });

  it("does not preview or block an unmodified difference", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.shadow = false;
    const preview = buildSettingsOverwritePreview({
      baseline: base,
      patch: settingsPatch(base, draft),
      persistedSettings: persistedFor(base, {
        "caps.queue": { value: 49, differsFromLive: true },
      }),
    });
    expect(entriesOf(preview)).toEqual([]);
    expect(
      settingsSaveConfirmation({ shadowOff: false, entries: entriesOf(preview) }),
    ).toBeNull();
  });

  it("shows every changed differing field", () => {
    const base = baseConfig();
    base.caps.queue = 50;
    base.decision.timeoutMs = 2000;
    const draft = copyConfig(base);
    draft.caps.queue = 48;
    draft.decision.timeoutMs = 2222;
    const entries = entriesOf(
      buildSettingsOverwritePreview({
        baseline: base,
        patch: settingsPatch(base, draft),
        persistedSettings: persistedFor(base, {
          "caps.queue": { value: 49, differsFromLive: true },
          "decision.timeoutMs": { value: 1999, differsFromLive: true },
        }),
      }),
    );
    expect(entries).toEqual([
      { path: "decision.timeoutMs", live: 2000, disk: 1999, proposed: 2222 },
      { path: "caps.queue", live: 50, disk: 49, proposed: 48 },
    ]);
  });

  it("allows a deliberate override after explicit confirmation", () => {
    const base = baseConfig();
    base.caps.queue = 50;
    const draft = copyConfig(base);
    draft.caps.queue = 48;
    const entries = entriesOf(
      buildSettingsOverwritePreview({
        baseline: base,
        patch: settingsPatch(base, draft),
        persistedSettings: persistedFor(base, {
          "caps.queue": { value: 49, differsFromLive: true },
        }),
      }),
    );
    const confirmation = settingsSaveConfirmation({ shadowOff: false, entries });
    expect(confirmation?.confirmLabel).toBe("确认并保存");
    expect(planOf(buildSavePlan({ baseline: base, draft, revision: "rev-1" })).patch.caps?.queue).toBe(48);
  });

  it("uses differsFromLive instead of comparing the redacted disk display value", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.decision.timeoutMs = 2222;
    const entries = entriesOf(
      buildSettingsOverwritePreview({
        baseline: base,
        patch: settingsPatch(base, draft),
        persistedSettings: persistedFor(base, {
          "decision.timeoutMs": { value: 1999, differsFromLive: true },
        }),
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("decision.timeoutMs");
  });

  it("fails closed when metadata is missing or a patched field is absent", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.caps.queue = 48;
    const patch = settingsPatch(base, draft);
    expect(
      buildSettingsOverwritePreview({ baseline: base, patch, persistedSettings: null }),
    ).toEqual({ ok: false, reason: "missing-metadata", paths: ["caps.queue"] });

    const partial = persistedFor(base);
    delete partial["caps.queue"];
    expect(
      buildSettingsOverwritePreview({ baseline: base, patch, persistedSettings: partial }),
    ).toEqual({ ok: false, reason: "missing-field", paths: ["caps.queue"] });
  });

  it("masks endpoint secrets in live, disk and proposed previews without altering the patch", () => {
    const base = baseConfig();
    base.decision.endpoint = "http://user:pass@host:11434/v1?token=alpha#frag";
    const draft = copyConfig(base);
    draft.decision.endpoint = "http://user2:pass2@host:11434/v2?key=beta#frag2";
    const patch = settingsPatch(base, draft);
    const entries = entriesOf(
      buildSettingsOverwritePreview({
        baseline: base,
        patch,
        persistedSettings: persistedFor(base, {
          "decision.endpoint": {
            value: "http://***@host:11434/v1?***#***",
            differsFromLive: true,
          },
        }),
      }),
    );
    const message = formatSettingsOverwritePreview(entries);
    expect(message).toContain("host:11434");
    expect(message).not.toContain("user");
    expect(message).not.toContain("pass");
    expect(message).not.toContain("token=alpha");
    expect(message).not.toContain("key=beta");
    expect(message).not.toContain("frag");
    expect(patch.decision?.endpoint).toBe(draft.decision.endpoint);
  });

  it("labels a hidden endpoint as hidden or unavailable, never as an empty disk value", () => {
    const base = baseConfig();
    base.decision.endpoint = "http://user:pass@host:11434/v1?token=alpha#frag";
    const draft = copyConfig(base);
    draft.decision.endpoint = "http://user2:pass2@host:11434/v2?key=beta#frag2";
    const entries = entriesOf(
      buildSettingsOverwritePreview({
        baseline: base,
        patch: settingsPatch(base, draft),
        persistedSettings: persistedFor(base, {
          "decision.endpoint": { value: null, differsFromLive: true },
        }),
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.disk).toBeNull();
    const message = formatSettingsOverwritePreview(entries);
    expect(message).toContain("已隐藏或不可用");
    expect(message).not.toContain("（无）");
    expect(message).not.toContain("user");
    expect(message).not.toContain("pass");
    expect(message).not.toContain("token=alpha");
    expect(message).not.toContain("key=beta");
  });

  it("shows an absent variant honestly and keeps its null disk value", () => {
    const base = baseConfig();
    delete base.rewrite.model.variant;
    const draft = copyConfig(base);
    draft.rewrite.model.variant = "fast";
    const entries = entriesOf(
      buildSettingsOverwritePreview({
        baseline: base,
        patch: settingsPatch(base, draft),
        persistedSettings: persistedFor(base, {
          "rewrite.model.variant": { value: null, differsFromLive: true },
        }),
      }),
    );
    expect(entries).toEqual([
      { path: "rewrite.model.variant", live: null, disk: null, proposed: "fast" },
    ]);
    const message = formatSettingsOverwritePreview(entries);
    expect(message).toContain("（无）");
    expect(message).toContain("fast");
  });
});

describe("overwrite confirmation and save intent", () => {
  it("combines shadow and overwrite warnings without dropping either", () => {
    const base = baseConfig();
    base.caps.queue = 50;
    const draft = copyConfig(base);
    draft.shadow = false;
    draft.caps.queue = 48;
    const entries = entriesOf(
      buildSettingsOverwritePreview({
        baseline: base,
        patch: settingsPatch(base, draft),
        persistedSettings: persistedFor(base, {
          "caps.queue": { value: 49, differsFromLive: true },
        }),
      }),
    );

    const both = settingsSaveConfirmation({ shadowOff: true, entries });
    expect(both?.message).toContain("关闭 Shadow");
    expect(both?.message).toContain("caps.queue");
    expect(both?.danger).toBe(true);

    const shadowOnly = settingsSaveConfirmation({ shadowOff: true, entries: [] });
    expect(shadowOnly?.title).toBe("开启真实自动写入？");
    expect(shadowOnly?.message).toContain("关闭 Shadow");

    const previewOnly = settingsSaveConfirmation({ shadowOff: false, entries });
    expect(previewOnly?.message).toContain("磁盘已保存");
    expect(previewOnly?.message).not.toContain("关闭 Shadow");

    expect(settingsSaveConfirmation({ shadowOff: false, entries: [] })).toBeNull();
  });

  it("rejects confirmation after the draft, baseline, revision or metadata changed", () => {
    const base = baseConfig();
    base.caps.queue = 50;
    const draft = copyConfig(base);
    draft.shadow = false;
    draft.caps.queue = 48;
    const plan = planOf(buildSavePlan({ baseline: base, draft, revision: "rev-1" }));
    const metadata = persistedFor(base, {
      "caps.queue": { value: 49, differsFromLive: true },
    });
    const intent = settingsSaveIntent(plan, base, draft, metadata);
    expect(sameSaveIntent(intent, settingsSaveIntent(plan, base, draft, metadata))).toBe(true);

    const editedDraft = copyConfig(draft);
    editedDraft.decision.timeoutMs = 999;
    const editedPlan = planOf(
      buildSavePlan({ baseline: base, draft: editedDraft, revision: "rev-1" }),
    );
    expect(
      sameSaveIntent(intent, settingsSaveIntent(editedPlan, base, editedDraft, metadata)),
    ).toBe(false);

    const movedBaseline = copyConfig(base);
    movedBaseline.caps.queue = 49;
    const movedPlan = planOf(
      buildSavePlan({ baseline: movedBaseline, draft, revision: "rev-1" }),
    );
    expect(
      sameSaveIntent(intent, settingsSaveIntent(movedPlan, movedBaseline, draft, metadata)),
    ).toBe(false);

    const revisionPlan = planOf(buildSavePlan({ baseline: base, draft, revision: "rev-2" }));
    expect(
      sameSaveIntent(intent, settingsSaveIntent(revisionPlan, base, draft, metadata)),
    ).toBe(false);

    const changedMetadata = persistedFor(base, {
      "caps.queue": { value: 49, differsFromLive: false },
    });
    expect(
      sameSaveIntent(intent, settingsSaveIntent(plan, base, draft, changedMetadata)),
    ).toBe(false);
  });

  it("compares the live baseline value itself, not only the patch", () => {
    const base = baseConfig();
    base.caps.queue = 50;
    const draft = copyConfig(base);
    draft.caps.queue = 48;
    const metadata = persistedFor(base);
    const beforePlan = planOf(buildSavePlan({ baseline: base, draft, revision: "rev-1" }));
    const movedBase = copyConfig(base);
    movedBase.caps.queue = 49;
    const movedPlan = planOf(buildSavePlan({ baseline: movedBase, draft, revision: "rev-1" }));
    expect(movedPlan.patch).toEqual(beforePlan.patch);
    expect(
      sameSaveIntent(
        settingsSaveIntent(beforePlan, base, draft, metadata),
        settingsSaveIntent(movedPlan, movedBase, draft, metadata),
      ),
    ).toBe(false);
  });

  it("keeps the old revision and metadata across a dirty background refresh", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.caps.queue = 48;
    const oldMetadata = persistedFor(base, {
      "caps.queue": { value: 50, differsFromLive: false },
    });
    const newMetadata = persistedFor(base, {
      "caps.queue": { value: 49, differsFromLive: true },
    });
    expect(
      evaluateLoadedConfig({
        requestId: 1,
        latestRequestId: 1,
        applied: false,
        baselineRevision: "rev-1",
        incomingRevision: "rev-2",
      }),
    ).toEqual({ kind: "concurrent", revision: "rev-2" });

    const oldPlan = planOf(buildSavePlan({ baseline: base, draft, revision: "rev-1" }));
    const kept = settingsSaveIntent(oldPlan, base, draft, oldMetadata);
    const incoming = settingsSaveIntent(oldPlan, base, draft, newMetadata);
    expect(kept.plan.revision).toBe("rev-1");
    expect(sameSaveIntent(kept, incoming)).toBe(false);
  });

  it("adopts the success response revision and metadata from the same snapshot", () => {
    const base = baseConfig();
    base.caps.queue = 50;
    const after = copyConfig(base);
    after.caps.queue = 48;
    const snapshot = readConfigSnapshot({
      ...after,
      configRevision: "rev-2",
      persistedSettings: persistedFor(after),
    });
    expect(snapshot.revision).toBe("rev-2");
    expect(snapshot.config.caps.queue).toBe(48);
    expect(snapshot.persistedSettings?.["caps.queue"]).toEqual({
      value: 48,
      differsFromLive: false,
    });
    expect(snapshot.config).not.toHaveProperty("persistedSettings");
    expect(snapshot.config).not.toHaveProperty("configRevision");
  });

  it("classifies a 409 as a conflict without inventing a new revision", () => {
    const base = baseConfig();
    const draft = copyConfig(base);
    draft.caps.queue = 48;
    const plan = planOf(buildSavePlan({ baseline: base, draft, revision: "rev-1" }));
    expect(isConfigRevisionConflict(409)).toBe(true);
    expect(isConfigRevisionConflict(400)).toBe(false);
    expect(isConfigRevisionConflict(500)).toBe(false);
    expect(plan.revision).toBe("rev-1");
  });
});
