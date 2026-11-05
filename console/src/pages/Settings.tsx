import { useEffect, useState } from "react";
import { api } from "../api";
import { confirmAction } from "../extension/confirm";
import { isExtension } from "../extension/mode";
import type { Config, Health } from "../types";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

export function SettingsPage({ refreshKey, onChanged }: Props) {
  const [config, setConfig] = useState<Config>();
  const [health, setHealth] = useState<Health>();
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<Config>("/api/config"), api<Health>("/api/health")])
      .then(([nextConfig, nextHealth]) => {
        setConfig(nextConfig);
        setHealth(nextHealth);
        setSavedSnapshot(JSON.stringify(nextConfig));
        setError("");
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [refreshKey]);

  useEffect(() => {
    if (config && savedSnapshot && JSON.stringify(config) !== savedSnapshot) {
      setMessage("");
    }
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
    const previous = JSON.parse(savedSnapshot || "{}") as Partial<Config>;
    if (previous.shadow === true && config.shadow === false) {
      const ok = await confirmAction({ title: "开启真实自动写入？", message: "关闭 Shadow 后，符合条件的事实和偏好会写入长期记忆；规则仍需人工确认。", confirmLabel: "开启自动写入" });
      if (!ok) return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await api<Config>("/api/config", {
        method: "PATCH",
        body: JSON.stringify({
          shadow: config.shadow,
          autoMemory: config.autoMemory,
          autoRules: config.autoRules,
          decision: config.decision,
          rewrite: config.rewrite,
          review: config.review,
          digest: config.digest,
          thresholds: config.thresholds,
          caps: config.caps,
        }),
      });
      setConfig(next);
      setSavedSnapshot(JSON.stringify(next));
      setMessage("已保存。下一轮 session.idle 生效；模型/端口类变更建议重启实例。");
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!config) {
    return <div className="empty">{error || "Loading settings…"}</div>;
  }

  const keySource = health?.decision.keySource ?? "missing";
  const dirty = Boolean(config) && JSON.stringify(config) !== savedSnapshot;
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

      <div
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <button className="btn primary" disabled={busy} onClick={() => void save()} type="button">
          {busy ? "Saving…" : "Save settings"}
        </button>
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
