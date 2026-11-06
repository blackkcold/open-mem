import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { confirmAction } from "../extension/confirm";
import { isExtension } from "../extension/mode";
import type { Config, Health } from "../types";
import { applyLoad, applySaveResult, isDraftDirty, newLoadTicket } from "./draft-state";
import type { LoadOutcome } from "./draft-state";
import {
  buildSavePlan,
  buildSettingsOverwritePreview,
  evaluateLoadedConfig,
  isConfigRevisionConflict,
  readConfigSnapshot,
  sameSaveIntent,
  settingsSaveBody,
  settingsSaveConfirmation,
  settingsSaveIntent,
} from "./settings-diff";
import type {
  ConfigWithRevision,
  LoadedConfigDecision,
  PersistedSettings,
} from "./settings-diff";

interface Props {
  refreshKey: number;
  onChanged: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

type ConfigLoadResult =
  | { kind: "stale" }
  | { kind: "failed" }
  | { kind: "loaded"; outcome: LoadOutcome; decision: LoadedConfigDecision };

export function SettingsPage({ refreshKey, onChanged, onDirtyChange }: Props) {
  const [config, setConfig] = useState<Config>();
  const [health, setHealth] = useState<Health>();
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [baselineRevision, setBaselineRevision] = useState<string | null>(null);
  const [revisionBlocked, setRevisionBlocked] = useState(false);
  const [metadataBlocked, setMetadataBlocked] = useState(false);
  const [conflictBlocked, setConflictBlocked] = useState(false);
  const [concurrentRevision, setConcurrentRevision] = useState<string | null>(null);

  // Async load/save callbacks must decide against the draft as it is when the
  // response arrives, not against the render that started the request.
  const configRef = useRef<Config | undefined>(undefined);
  const baselineRef = useRef<Config | undefined>(undefined);
  const savedRef = useRef("");
  const loadSeq = useRef(0);
  const revisionRef = useRef<string | null>(null);
  const persistedSettingsRef = useRef<PersistedSettings | null>(null);
  const saveContextSeq = useRef(0);

  useLayoutEffect(() => {
    configRef.current = config;
  }, [config]);
  useLayoutEffect(() => {
    savedRef.current = savedSnapshot;
  }, [savedSnapshot]);

  /**
   * Accept a server config as the form baseline. The revision and the
   * persistedSettings snapshot are stored next to the baseline, never inside
   * the config value or the dirty JSON.
   */
  const acceptBaseline = useCallback(
    (
      nextConfig: Config,
      revision: string | null,
      metadata: PersistedSettings | null,
      adoptDraft: boolean,
    ) => {
      baselineRef.current = nextConfig;
      revisionRef.current = revision;
      persistedSettingsRef.current = metadata;
      setMetadataBlocked(metadata === null);
      setBaselineRevision(revision);
      savedRef.current = JSON.stringify(nextConfig);
      setSavedSnapshot(savedRef.current);
      if (adoptDraft) {
        configRef.current = nextConfig;
        setConfig(nextConfig);
      }
    },
    [],
  );

  const loadConfig = useCallback(
    async (explicit: boolean): Promise<ConfigLoadResult> => {
      const ticket = newLoadTicket(++loadSeq.current, draftOf(configRef.current));
      try {
        const [response, nextHealth] = await Promise.all([
          api<ConfigWithRevision>("/api/config"),
          api<Health>("/api/health"),
        ]);
        const snapshot = readConfigSnapshot(response);
        const nextConfig = snapshot.config;
        const incomingRevision = snapshot.revision;
        const incomingMetadata = snapshot.persistedSettings;
        const outcome = applyLoad({
          ticket,
          latestTicketId: loadSeq.current,
          draft: draftOf(configRef.current),
          saved: savedRef.current,
          loaded: JSON.stringify(nextConfig),
          explicit,
        });
        const decision = evaluateLoadedConfig({
          requestId: ticket.id,
          latestRequestId: loadSeq.current,
          applied: outcome.applied,
          baselineRevision: revisionRef.current,
          incomingRevision,
        });
        if (decision.kind === "stale") return { kind: "stale" };

        // Any completed refresh changes the state a pending shadow
        // confirmation was based on, so that attempt must be re-confirmed.
        saveContextSeq.current += 1;
        setHealth(nextHealth);
        setError("");

        if (decision.kind === "invalid-revision") {
          setRevisionBlocked(true);
          setConcurrentRevision(null);
          // Show the config if the form accepted it, but never pretend to
          // have a usable version (or metadata) for an atomic save.
          if (outcome.applied) {
            acceptBaseline(nextConfig, null, incomingMetadata, true);
          } else {
            setMetadataBlocked(
              incomingMetadata === null || persistedSettingsRef.current === null,
            );
          }
          return { kind: "loaded", outcome, decision };
        }

        setRevisionBlocked(false);

        if (decision.kind === "baseline") {
          setConflictBlocked(false);
          setConcurrentRevision(null);
          acceptBaseline(nextConfig, decision.revision, incomingMetadata, true);
          return { kind: "loaded", outcome, decision };
        }

        // A valid revision arrived, but the dirty form did not accept the
        // baseline. Keep the old baseline and its old metadata; only fail when
        // there is no usable metadata to preview with.
        setRevisionBlocked(revisionRef.current === null);
        setMetadataBlocked(
          incomingMetadata === null || persistedSettingsRef.current === null,
        );

        if (decision.kind === "concurrent") {
          // Keep the dirty draft, the saved snapshot, the accepted revision
          // and the accepted metadata. The warning tells the user a merge
          // needs a reload.
          setConcurrentRevision(decision.revision);
        } else {
          setConflictBlocked(false);
          setConcurrentRevision(null);
        }
        return { kind: "loaded", outcome, decision };
      } catch (caught: unknown) {
        if (ticket.id !== loadSeq.current) return { kind: "stale" };
        setError(errorMessage(caught));
        return { kind: "failed" };
      }
    },
    [acceptBaseline],
  );

  useEffect(() => {
    void loadConfig(false);
  }, [refreshKey, loadConfig]);

  const dirty = config !== undefined && isDraftDirty(JSON.stringify(config), savedSnapshot);
  const saveBlocked =
    baselineRevision === null || revisionBlocked || metadataBlocked || conflictBlocked;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    // Unmounting (disconnect, token gate, error screen) must clear the
    // registration so a stale dirty flag cannot warn about a gone draft.
    return () => {
      onDirtyChange(false);
    };
  }, [onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function reloadConfig() {
    if (dirty) {
      const ok = await confirmAction({
        title: "放弃未保存的修改？",
        message: "重新加载会用服务端最新配置覆盖当前草稿。",
        confirmLabel: "重新加载",
      });
      if (!ok) return;
    }
    setReloading(true);
    setError("");
    setMessage("");
    setNotice("");
    const result = await loadConfig(true);
    if (result.kind === "stale") {
      setNotice("重新加载被后台刷新抢占，未按本次操作应用；请重试确认最新配置。");
    } else if (result.kind === "loaded" && !result.outcome.applied) {
      setNotice("重新加载期间有新的编辑，已保留当前草稿。");
    }
    setReloading(false);
  }

  useEffect(() => {
    if (!config || !savedSnapshot) return;
    if (JSON.stringify(config) !== savedSnapshot) setMessage("");
    else setNotice("");
  }, [config, savedSnapshot]);

  function setThreshold(key: keyof Config["thresholds"], value: number) {
    setConfig((current) =>
      current ? { ...current, thresholds: { ...current.thresholds, [key]: value } } : current,
    );
  }

  function setCap(key: keyof Config["caps"], value: number) {
    setConfig((current) =>
      current ? { ...current, caps: { ...current.caps, [key]: value } } : current,
    );
  }

  function setDecision<K extends keyof Config["decision"]>(
    key: K,
    value: Config["decision"][K],
  ) {
    setConfig((current) =>
      current ? { ...current, decision: { ...current.decision, [key]: value } } : current,
    );
  }

  function setRewrite<K extends keyof Omit<Config["rewrite"], "model">>(
    key: K,
    value: Config["rewrite"][K],
  ) {
    setConfig((current) =>
      current ? { ...current, rewrite: { ...current.rewrite, [key]: value } } : current,
    );
  }

  function setRewriteModel(key: "providerID" | "id" | "variant", value: string) {
    setConfig((current) =>
      current
        ? {
            ...current,
            rewrite: {
              ...current.rewrite,
              model: { ...current.rewrite.model, [key]: value },
            },
          }
        : current,
    );
  }

  function setReview<K extends keyof Omit<Config["review"], "model">>(
    key: K,
    value: Config["review"][K],
  ) {
    setConfig((current) =>
      current ? { ...current, review: { ...current.review, [key]: value } } : current,
    );
  }

  function setReviewModel(key: "providerID" | "id" | "variant", value: string) {
    setConfig((current) =>
      current
        ? {
            ...current,
            review: {
              ...current.review,
              model: { ...current.review.model, [key]: value },
            },
          }
        : current,
    );
  }

  async function save() {
    if (!config) return;
    if (saveBlocked) {
      if (baselineRevision === null) setRevisionBlocked(true);
      return;
    }

    const baseline = baselineRef.current;
    if (!baseline) {
      setError("缺少配置基线，请重新加载后再保存。");
      return;
    }
    let draft = configRef.current ?? config;
    const initial = buildSavePlan({
      baseline,
      draft,
      revision: revisionRef.current,
    });
    if (!initial.ok) {
      if (initial.reason === "missing-revision") {
        setRevisionBlocked(true);
      } else if (initial.reason === "missing-baseline") {
        setError("缺少配置基线，请重新加载后再保存。");
      } else {
        setNotice("没有需要保存的修改。");
      }
      return;
    }

    const metadata = persistedSettingsRef.current;
    if (!metadata) {
      setMetadataBlocked(true);
      return;
    }
    const preview = buildSettingsOverwritePreview({
      baseline,
      patch: initial.plan.patch,
      persistedSettings: metadata,
    });
    if (!preview.ok) {
      if (preview.reason === "missing-field") {
        setMetadataBlocked(true);
        setError(
          `persistedSettings 缺少本次修改字段：${preview.paths.join("、")}；请重新加载。`,
        );
      } else if (preview.reason === "invalid-baseline") {
        setError("配置基线缺少可编辑字段，请重新加载。");
      } else {
        setMetadataBlocked(true);
      }
      return;
    }

    let plan = initial.plan;
    const turningOffShadow =
      baseline.shadow === true && initial.plan.patch.shadow === false;
    const confirmation = settingsSaveConfirmation({
      shadowOff: turningOffShadow,
      entries: preview.entries,
    });
    if (confirmation) {
      const intent = settingsSaveIntent(initial.plan, baseline, draft, metadata);
      const context = saveContextSeq.current;
      const ok = await confirmAction({
        title: confirmation.title,
        message: confirmation.message,
        confirmLabel: confirmation.confirmLabel,
        cancelLabel: "取消",
        danger: confirmation.danger,
      });
      if (!ok) return;
      // The confirmed dialog must describe the exact request that is sent: a
      // refresh, a field edit, a baseline/revision change or a metadata change
      // during the dialog cancels this attempt and asks again.
      if (saveContextSeq.current !== context) {
        setNotice("确认期间配置或服务端状态已刷新，未提交；请重新确认后再保存。");
        return;
      }
      draft = configRef.current ?? draft;
      const afterBaseline = baselineRef.current;
      const afterMetadata = persistedSettingsRef.current;
      const after = buildSavePlan({
        baseline: afterBaseline,
        draft,
        revision: revisionRef.current,
      });
      if (!after.ok || !afterBaseline || !afterMetadata) {
        setNotice("确认期间基线、版本或差异数据已变化，未提交；请重新确认后再保存。");
        return;
      }
      if (
        !sameSaveIntent(
          intent,
          settingsSaveIntent(after.plan, afterBaseline, draft, afterMetadata),
        )
      ) {
        setNotice(
          "确认期间基线、版本、差异数据或草稿已变化，未提交；请重新确认后再保存。",
        );
        return;
      }
      plan = after.plan;
    }

    const submitted = JSON.stringify(draft);
    // Drop responses from loads issued before this save; they may carry the
    // pre-save snapshot and would otherwise look clean when they return.
    loadSeq.current += 1;
    setBusy(true);
    setError("");
    setMessage("");
    setNotice("");
    try {
      // Only changed editable fields plus the accepted baseline revision.
      const response = await api<ConfigWithRevision>("/api/config", {
        method: "PATCH",
        body: JSON.stringify(settingsSaveBody(plan)),
      });
      const snapshot = readConfigSnapshot(response);
      const outcome = applySaveResult({
        ok: true,
        submitted,
        currentDraft: draftOf(configRef.current),
        savedBefore: savedRef.current,
        responseSaved: JSON.stringify(snapshot.config),
      });
      acceptBaseline(
        snapshot.config,
        snapshot.revision,
        snapshot.persistedSettings,
        outcome.adoptResponse,
      );
      setConflictBlocked(false);
      setConcurrentRevision(null);
      setRevisionBlocked(snapshot.revision === null);
      if (outcome.keptNewerEdits) {
        setMessage("");
        setNotice("已保存上一版；保存期间的新修改仍未保存。");
      } else if (snapshot.revision === null) {
        setMessage("已保存；但服务端未返回新的配置版本，已禁止继续保存。");
      } else if (snapshot.persistedSettings === null) {
        setMessage("已保存；但服务端未返回完整的 persistedSettings，已禁止继续保存。");
      } else {
        setNotice("");
        setMessage("已保存。下一轮 session.idle 生效；模型/端口类变更建议重启实例。");
      }
      onChanged();
    } catch (caught: unknown) {
      if (caught instanceof ApiError && isConfigRevisionConflict(caught.status)) {
        // Atomic revision check failed: preserve the draft, the accepted
        // baseline, metadata and the old revision exactly. No automatic retry.
        setConflictBlocked(true);
        setError("");
        setNotice("");
      } else {
        // A failed save keeps both the draft and the previous baseline.
        const outcome = applySaveResult({
          ok: false,
          submitted,
          currentDraft: draftOf(configRef.current),
          savedBefore: savedRef.current,
          responseSaved: savedRef.current,
        });
        savedRef.current = outcome.saved;
        setSavedSnapshot(outcome.saved);
        setNotice("");
        setError(errorMessage(caught));
      }
    } finally {
      // A load issued while the request was in flight may have read the server
      // before it persisted this change; never let it replace the draft.
      loadSeq.current += 1;
      setBusy(false);
    }
  }

  if (!config) {
    return <div className="empty">{error || "Loading settings…"}</div>;
  }

  const keySource = health?.decision.keySource ?? "missing";
  const keyLabel =
    keySource === "env"
      ? "环境变量 OLLAMA_API_KEY"
      : keySource === "auth"
        ? "OpenCode auth（只读）"
        : "未配置";

  return (
    <div className="settings">
      <section className="panel">
        <div className="panel-head"><h2>写入策略</h2><span className="meta">auto vs queue</span></div>
        <div className="detail-body">
          <label className="row">
            <input
              type="checkbox"
              checked={config.shadow}
              onChange={(event) => setConfig({ ...config, shadow: event.target.checked })}
            />
            <span>Shadow mode：只观察，不自动写入；会话复盘启用时仍会调用模型</span>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={config.autoMemory}
              onChange={(event) => setConfig({ ...config, autoMemory: event.target.checked })}
            />
            <span>允许自动写 facts / preferences / references</span>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={false}
              disabled
            />
            <span>规则始终需要人工批准，不会自动写入</span>
          </label>
          <p className="muted small" style={{ margin: 0 }}>
            Shadow 开启时只记录“本来会写入什么”，不落盘；关闭 Shadow 后，低风险、无重复、
            无冲突的条目才会自动写入。高危、冲突、重复、低置信、规则合并和 skill 始终需要人工。
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>System One · 决策</h2>
          <span className={`badge ${keySource === "missing" ? "warning" : "success"}`}>{keyLabel}</span>
        </div>
        <div className="detail-body">
          <div className="field">
            <label>模式</label>
            <select
              className="select"
              value={config.decision.kind}
              aria-label="决策模式"
              onChange={(event) =>
                setDecision("kind", event.target.value as Config["decision"]["kind"])
              }
            >
              <option value="systemone">System One（真实端点）</option>
              <option value="heuristic">Heuristic（离线兜底）</option>
            </select>
          </div>
          <div className="field">
            <label>端点</label>
            <input
              className="input"
              value={config.decision.endpoint}
              aria-label="决策模型端点"
              onChange={(event) => setDecision("endpoint", event.target.value)}
            />
          </div>
          <div className="field">
            <label>模型</label>
            <input
              className="input"
              value={config.decision.model}
              aria-label="决策模型"
              onChange={(event) => setDecision("model", event.target.value)}
              placeholder="clef:27b-cloud"
            />
          </div>
          <div className="field">
            <label>Key 环境变量名</label>
            <input
              className="input"
              value={config.decision.apiKeyEnv}
              aria-label="密钥环境变量名"
              onChange={(event) => setDecision("apiKeyEnv", event.target.value)}
            />
          </div>
          <div className="field">
            <label>超时（ms）</label>
            <input
              className="input"
              type="number"
              value={config.decision.timeoutMs}
              aria-label="决策超时毫秒"
              onChange={(event) => setDecision("timeoutMs", Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>每小时最多调用</label>
            <input
              className="input"
              type="number"
              value={config.decision.maxCallsPerHour}
              aria-label="决策每小时请求上限"
              onChange={(event) => setDecision("maxCallsPerHour", Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>结果缓存（小时）</label>
            <input
              className="input"
              type="number"
              value={config.decision.cacheTtlHours}
              aria-label="决策结果缓存小时"
              onChange={(event) => setDecision("cacheTtlHours", Number(event.target.value))}
            />
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Key 只从环境变量或 OpenCode auth 读取，不显示、不写入配置文件。端点失败会自动降级 heuristic。
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>System Two · 重写</h2>
          <span className="meta">合并文本</span>
        </div>
        <div className="detail-body">
          <label className="row">
            <input
              type="checkbox"
              checked={config.rewrite.enabled}
              onChange={(event) => setRewrite("enabled", event.target.checked)}
            />
            <span>启用重写（关闭则只做模板合并）</span>
          </label>
          <div className="field">
            <label>传输</label>
            <select
              className="select"
              value={config.rewrite.transport}
              aria-label="重写传输方式"
              onChange={(event) =>
                setRewrite("transport", event.target.value as Config["rewrite"]["transport"])
              }
            >
              <option value="opencode">OpenCode generate.text</option>
              <option value="ollama">Ollama /api/chat（format=json）</option>
            </select>
          </div>
          <div className="field">
            <label>Provider ID</label>
            <input
              className="input"
              value={config.rewrite.model.providerID}
              aria-label="重写模型 Provider ID"
              onChange={(event) => setRewriteModel("providerID", event.target.value)}
            />
          </div>
          <div className="field">
            <label>模型 ID</label>
            <input
              className="input"
              value={config.rewrite.model.id}
              aria-label="重写模型 ID"
              onChange={(event) => setRewriteModel("id", event.target.value)}
            />
          </div>
          <div className="field">
            <label>推理变体</label>
            <input
              className="input"
              placeholder="high / max / default（留空使用模型默认）"
              value={config.rewrite.model.variant ?? ""}
              aria-label="重写推理变体"
              onChange={(event) => setRewriteModel("variant", event.target.value)}
            />
          </div>
          <label className="row">
            <input
              type="checkbox"
              checked={config.rewrite.eager}
              onChange={(event) => setRewrite("eager", event.target.checked)}
            />
            <span>入队后自动生成建议（关闭后需手动点击“生成建议”）</span>
          </label>
          <div className="field">
            <label>超时（ms）</label>
            <input
              className="input"
              type="number"
              value={config.rewrite.timeoutMs}
              aria-label="重写超时毫秒"
              onChange={(event) => setRewrite("timeoutMs", Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>每小时最多调用</label>
            <input
              className="input"
              type="number"
              value={config.rewrite.maxCallsPerHour}
              aria-label="重写每小时请求上限"
              onChange={(event) => setRewrite("maxCallsPerHour", Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>修复尝试次数</label>
            <input
              className="input"
              type="number"
              value={config.rewrite.repairAttempts}
              aria-label="重写修复尝试次数"
              onChange={(event) => setRewrite("repairAttempts", Number(event.target.value))}
            />
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            只在 merge / replace 时调用。输出必须通过 linter、数值守卫和保留检查；失败自动用模板合并，审批页仍可一键批准。
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Session Review · 会话复盘</h2>
          <span
            className={`badge ${
              dirty ? "warning" : config.review.enabled ? "success" : "warning"
            }`}
          >
            {dirty
              ? `未保存 · 将${config.review.enabled ? "开启" : "关闭"}`
              : config.review.enabled
                ? "开启"
                : "已关闭"}
          </span>
        </div>
        <div className="detail-body">
          <label className="row">
            <input
              type="checkbox"
              checked={config.review.enabled}
              onChange={(event) => setReview("enabled", event.target.checked)}
            />
            <span>会话空闲后自动复盘（候选只进队列，永不自动写）</span>
          </label>
          <div className="field">
            <label htmlFor="review-idle">空闲阈值（分钟）</label>
            <input
              id="review-idle"
              className="input"
              type="number"
              min={1}
              value={Math.max(1, Math.round(config.review.idleMs / 60_000))}
              onChange={(event) =>
                setReview("idleMs", Math.max(1, Number(event.target.value)) * 60_000)
              }
            />
          </div>
          <div className="field">
            <label htmlFor="review-per-hour">每小时最多复盘</label>
            <input
              id="review-per-hour"
              className="input"
              type="number"
              min={1}
              max={48}
              value={config.review.maxPerHour}
              onChange={(event) =>
                setReview(
                  "maxPerHour",
                  Math.max(1, Math.min(48, Math.round(Number(event.target.value) || 1))),
                )
              }
            />
          </div>
          <div className="field">
            <label htmlFor="review-candidates">每次最多候选</label>
            <input
              id="review-candidates"
              className="input"
              type="number"
              min={1}
              max={50}
              value={config.review.maxCandidates}
              onChange={(event) =>
                setReview(
                  "maxCandidates",
                  Math.max(1, Math.min(50, Math.round(Number(event.target.value) || 1))),
                )
              }
            />
          </div>
          <div className="field">
            <label htmlFor="review-transcript">输入范围</label>
            <select
              id="review-transcript"
              className="select"
              value={config.review.transcript}
              onChange={(event) =>
                setReview(
                  "transcript",
                  event.target.value as Config["review"]["transcript"],
                )
              }
            >
              <option value="user+tools">user 原文 + 工具摘要</option>
              <option value="user">仅 user 原文</option>
            </select>
          </div>
          <label className="row">
            <input
              type="checkbox"
              checked={config.review.redact}
              onChange={(event) => setReview("redact", event.target.checked)}
            />
            <span>入模前脱敏（密钥 / token / 绝对路径）</span>
          </label>
          <div className="field">
            <label htmlFor="review-provider">模型 Provider ID</label>
            <input
              id="review-provider"
              className="input"
              value={config.review.model.providerID}
              onChange={(event) => setReviewModel("providerID", event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="review-model">模型 ID</label>
            <input
              id="review-model"
              className="input"
              value={config.review.model.id}
              onChange={(event) => setReviewModel("id", event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="review-variant">推理变体</label>
            <input
              id="review-variant"
              className="input"
              placeholder="high / max / default（留空使用模型默认）"
              value={config.review.model.variant ?? ""}
              onChange={(event) => setReviewModel("variant", event.target.value)}
            />
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            复盘候选永远只进审批队列；关闭后不再发起后台模型调用，已排期的计时器会立即停止。
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>阈值</h2><span className="meta">linter + priority</span></div>
        <div className="detail-body">
          <div className="field">
            <label>Memory max chars</label>
            <input className="input" aria-label="记忆最大字数" type="number" value={config.thresholds.memoryMaxChars} onChange={(event) => setThreshold("memoryMaxChars", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Rule max chars</label>
            <input className="input" aria-label="规则最大字数" type="number" value={config.thresholds.ruleMaxChars} onChange={(event) => setThreshold("ruleMaxChars", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Title max chars</label>
            <input className="input" aria-label="标题最大字数" type="number" value={config.thresholds.titleMaxChars} onChange={(event) => setThreshold("titleMaxChars", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>auto_ok min (project)</label>
            <input className="input" aria-label="项目自动写入阈值" type="number" step="0.01" value={config.thresholds.autoOkMin} onChange={(event) => setThreshold("autoOkMin", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>auto_ok min (global)</label>
            <input className="input" aria-label="全局自动写入阈值" type="number" step="0.01" value={config.thresholds.globalAutoOkMin} onChange={(event) => setThreshold("globalAutoOkMin", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>duplicate max</label>
            <input className="input" aria-label="重复阈值" type="number" step="0.01" value={config.thresholds.duplicateMax} onChange={(event) => setThreshold("duplicateMax", Number(event.target.value))} />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>容量</h2><span className="meta">硬上限</span></div>
        <div className="detail-body">
          <div className="field">
            <label>AUTO_MEMORY max items</label>
            <input className="input" aria-label="自动记忆容量" type="number" value={config.caps.autoMemory} onChange={(event) => setCap("autoMemory", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>AUTO_RULES max items</label>
            <input className="input" aria-label="规则容量" type="number" value={config.caps.autoRules} onChange={(event) => setCap("autoRules", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Queue max items</label>
            <input className="input" aria-label="队列容量" type="number" value={config.caps.queue} onChange={(event) => setCap("queue", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Shadow max items</label>
            <input className="input" aria-label="观察历史容量" type="number" value={config.caps.shadow} onChange={(event) => setCap("shadow", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Skill drafts max</label>
            <input className="input" aria-label="流程草稿容量" type="number" value={config.caps.skillDrafts} onChange={(event) => setCap("skillDrafts", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Total items max</label>
            <input className="input" aria-label="总记忆容量" type="number" value={config.caps.itemsTotal} onChange={(event) => setCap("itemsTotal", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Disk budget (MB)</label>
            <input
              className="input"
              type="number"
              value={Math.round(config.caps.diskBytes / (1024 * 1024))}
              aria-label="磁盘预算 MB"
              onChange={(event) =>
                setCap("diskBytes", Math.max(1, Number(event.target.value)) * 1024 * 1024)
              }
            />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>环境</h2><span className="meta">local only</span></div>
        <div className="detail-body">
          <div className="field">
            <label>Data directory</label>
            <input className="input" aria-label="数据目录" readOnly value={health?.dataDir ?? config.dataDir ?? ""} />
          </div>
          <div className="field">
            <label>Console origin</label>
            <input
              className="input"
              readOnly
              aria-label="控制台来源"
              value={
                isExtension()
                  ? "OpenChamber 扩展（serviceRequest 代理）"
                  : window.location.origin
              }
            />
          </div>
          <div className="field">
            <label>Decision key source</label>
            <input className="input" aria-label="决策密钥来源" readOnly value={keyLabel} />
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            {isExtension()
              ? "Token 由扩展 service 持有，不进入面板；面板只通过 serviceRequest 访问本地 API。"
              : "Token 保存在 console-token（0600），不在此显示。服务仅供本机访问，不支持 LAN/手机直连。"}
          </p>
        </div>
      </section>

      {revisionBlocked || metadataBlocked || conflictBlocked || concurrentRevision ? (
        <div style={{ gridColumn: "1 / -1", display: "grid", gap: 8 }}>
          {revisionBlocked ? (
            <div className="banner error" role="alert" style={{ margin: 0 }}>
              当前没有可用于安全保存的配置版本（configRevision），保存已禁用。请点击“重新加载”获取最新配置；若仍出现，请升级控制台/插件。
            </div>
          ) : null}
          {metadataBlocked ? (
            <div className="banner error" role="alert" style={{ margin: 0 }}>
              服务端未返回完整且有效的 persistedSettings，无法安全预览跨实例差异，保存已禁用。请点击“重新加载”；若仍出现，请升级控制台/插件。
            </div>
          ) : null}
          {conflictBlocked ? (
            <div className="banner error" role="alert" style={{ margin: 0 }}>
              保存未写入（配置冲突）：服务端保存的配置版本已变化。当前草稿和保存基线已原样保留；请先复制需要的修改，再点击“重新加载”读取最新配置（会覆盖草稿）。
            </div>
          ) : null}
          {concurrentRevision ? (
            <div className="banner" role="status" style={{ margin: 0 }}>
              服务端保存的配置版本已变化；当前草稿和保存基线已保留，未自动合并。保存会用已接受的旧版本做冲突检查；如需采用服务端版本，请先复制修改再重新加载。
            </div>
          ) : null}
        </div>
      ) : null}

      <div
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button className="btn primary" disabled={busy || reloading || saveBlocked} onClick={() => void save()} type="button">
          {busy ? "Saving…" : "Save settings"}
        </button>
        <button className="btn" disabled={busy || reloading} onClick={() => void reloadConfig()} type="button">
          {reloading ? "Reloading…" : "重新加载"}
        </button>
        {dirty ? (
          <span className="muted small">
            有未保存的修改；后台刷新不会覆盖草稿。“重新加载”会放弃修改并读取服务端配置。
          </span>
        ) : null}
        {notice ? <span className="muted small">{notice}</span> : null}
        {message ? (
          <div className="banner ok" role="status" style={{ margin: 0 }}>
            {message}
          </div>
        ) : null}
        {error ? (
          <div className="banner error" role="alert" style={{ margin: 0 }}>
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftOf(config: Config | undefined): string {
  return config === undefined ? "" : JSON.stringify(config);
}
