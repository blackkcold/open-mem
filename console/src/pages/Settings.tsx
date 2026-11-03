import { useEffect, useState } from "react";
import { api } from "../api";
import type { Config, Health } from "../types";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

export function SettingsPage({ refreshKey, onChanged }: Props) {
  const [config, setConfig] = useState<Config>();
  const [health, setHealth] = useState<Health>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<Config>("/api/config"), api<Health>("/api/health")])
      .then(([nextConfig, nextHealth]) => {
        setConfig(nextConfig);
        setHealth(nextHealth);
        setError("");
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [refreshKey]);

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

  function setRewriteModel(key: "providerID" | "id", value: string) {
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

  async function save() {
    if (!config) return;
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
          thresholds: config.thresholds,
          caps: config.caps,
        }),
      });
      setConfig(next);
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
            <span>Shadow mode：只记录“本来会写入什么”，不真正写</span>
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
              checked={config.autoRules}
              onChange={(event) => setConfig({ ...config, autoRules: event.target.checked })}
            />
            <span>允许自动写低风险 additive rules（高风险仍进队列）</span>
          </label>
          <p className="muted small" style={{ margin: 0 }}>
            低风险、无重复、无冲突的条目自动写入；只有高危、冲突、重复、低置信、规则合并和 skill 需要人工。
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
              onChange={(event) => setDecision("endpoint", event.target.value)}
            />
          </div>
          <div className="field">
            <label>模型</label>
            <input
              className="input"
              value={config.decision.model}
              onChange={(event) => setDecision("model", event.target.value)}
              placeholder="clef:27b-cloud"
            />
          </div>
          <div className="field">
            <label>Key 环境变量名</label>
            <input
              className="input"
              value={config.decision.apiKeyEnv}
              onChange={(event) => setDecision("apiKeyEnv", event.target.value)}
            />
          </div>
          <div className="field">
            <label>超时（ms）</label>
            <input
              className="input"
              type="number"
              value={config.decision.timeoutMs}
              onChange={(event) => setDecision("timeoutMs", Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>每小时最多调用</label>
            <input
              className="input"
              type="number"
              value={config.decision.maxCallsPerHour}
              onChange={(event) => setDecision("maxCallsPerHour", Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>结果缓存（小时）</label>
            <input
              className="input"
              type="number"
              value={config.decision.cacheTtlHours}
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
              onChange={(event) => setRewriteModel("providerID", event.target.value)}
            />
          </div>
          <div className="field">
            <label>模型 ID</label>
            <input
              className="input"
              value={config.rewrite.model.id}
              onChange={(event) => setRewriteModel("id", event.target.value)}
            />
          </div>
          <label className="row">
            <input
              type="checkbox"
              checked={config.rewrite.eager}
              onChange={(event) => setRewrite("eager", event.target.checked)}
            />
            <span>入队后自动生成建议（关闭则打开候选时生成）</span>
          </label>
          <div className="field">
            <label>超时（ms）</label>
            <input
              className="input"
              type="number"
              value={config.rewrite.timeoutMs}
              onChange={(event) => setRewrite("timeoutMs", Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>每小时最多调用</label>
            <input
              className="input"
              type="number"
              value={config.rewrite.maxCallsPerHour}
              onChange={(event) => setRewrite("maxCallsPerHour", Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label>修复尝试次数</label>
            <input
              className="input"
              type="number"
              value={config.rewrite.repairAttempts}
              onChange={(event) => setRewrite("repairAttempts", Number(event.target.value))}
            />
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            只在 merge / replace 时调用。输出必须通过 linter、数值守卫和保留检查；失败自动用模板合并，审批页仍可一键批准。
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>阈值</h2><span className="meta">linter + priority</span></div>
        <div className="detail-body">
          <div className="field">
            <label>Memory max chars</label>
            <input className="input" type="number" value={config.thresholds.memoryMaxChars} onChange={(event) => setThreshold("memoryMaxChars", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Rule max chars</label>
            <input className="input" type="number" value={config.thresholds.ruleMaxChars} onChange={(event) => setThreshold("ruleMaxChars", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Title max chars</label>
            <input className="input" type="number" value={config.thresholds.titleMaxChars} onChange={(event) => setThreshold("titleMaxChars", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>auto_ok min (project)</label>
            <input className="input" type="number" step="0.01" value={config.thresholds.autoOkMin} onChange={(event) => setThreshold("autoOkMin", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>auto_ok min (global)</label>
            <input className="input" type="number" step="0.01" value={config.thresholds.globalAutoOkMin} onChange={(event) => setThreshold("globalAutoOkMin", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>duplicate max</label>
            <input className="input" type="number" step="0.01" value={config.thresholds.duplicateMax} onChange={(event) => setThreshold("duplicateMax", Number(event.target.value))} />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>容量</h2><span className="meta">硬上限</span></div>
        <div className="detail-body">
          <div className="field">
            <label>AUTO_MEMORY max items</label>
            <input className="input" type="number" value={config.caps.autoMemory} onChange={(event) => setCap("autoMemory", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>AUTO_RULES max items</label>
            <input className="input" type="number" value={config.caps.autoRules} onChange={(event) => setCap("autoRules", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Queue max items</label>
            <input className="input" type="number" value={config.caps.queue} onChange={(event) => setCap("queue", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Shadow max items</label>
            <input className="input" type="number" value={config.caps.shadow} onChange={(event) => setCap("shadow", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Skill drafts max</label>
            <input className="input" type="number" value={config.caps.skillDrafts} onChange={(event) => setCap("skillDrafts", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Total items max</label>
            <input className="input" type="number" value={config.caps.itemsTotal} onChange={(event) => setCap("itemsTotal", Number(event.target.value))} />
          </div>
          <div className="field">
            <label>Disk budget (MB)</label>
            <input
              className="input"
              type="number"
              value={Math.round(config.caps.diskBytes / (1024 * 1024))}
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
            <input className="input" readOnly value={health?.dataDir ?? config.dataDir ?? ""} />
          </div>
          <div className="field">
            <label>Console origin</label>
            <input className="input" readOnly value={window.location.origin} />
          </div>
          <div className="field">
            <label>Decision key source</label>
            <input className="input" readOnly value={keyLabel} />
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Token 保存在 <code>console-token</code>（0600），不在此显示。默认只绑 127.0.0.1；LAN/手机访问必须显式开启并保护。
          </p>
        </div>
      </section>

      <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn primary" disabled={busy} onClick={() => void save()} type="button">
          {busy ? "Saving…" : "Save settings"}
        </button>
        {message ? <span className="muted">{message}</span> : null}
        {error ? <span className="sev-error">{error}</span> : null}
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
