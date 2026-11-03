import { useEffect, useState } from "react";
import { api, formatAge, formatPercent } from "../api";
import type { HealthScore, MergeJournal, UsageSummary } from "../types";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

const BREAKDOWN_LABELS: Array<[keyof HealthScore["breakdown"], string]> = [
  ["capacity", "容量"],
  ["duplicates", "重复"],
  ["conflicts", "冲突"],
  ["falsePositive", "Shadow 误报"],
  ["queueAge", "队列年龄"],
  ["decisionFallback", "决策降级"],
  ["rewriteFallback", "重写降级"],
  ["acceptance", "建议拒绝率"],
  ["undo", "撤销次数"],
];

export function HealthPage({ refreshKey, onChanged }: Props) {
  const [health, setHealth] = useState<HealthScore>();
  const [usage, setUsage] = useState<UsageSummary>();
  const [journal, setJournal] = useState<MergeJournal[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void load();
  }, [refreshKey]);

  async function load() {
    try {
      const [nextHealth, nextUsage, nextJournal] = await Promise.all([
        api<HealthScore>("/api/health-score"),
        api<UsageSummary>("/api/usage"),
        api<{ items: MergeJournal[] }>("/api/journal"),
      ]);
      setHealth(nextHealth);
      setUsage(nextUsage);
      setJournal(nextJournal.items);
      setError("");
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    }
  }

  async function compact() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const result = await api<{
        merged: number;
        archived: number;
        itemsBefore: number;
        itemsAfter: number;
      }>("/api/compact", { method: "POST" });
      setMessage(
        `压缩完成：合并 ${result.merged} 条，归档 ${result.archived} 条，${result.itemsBefore} → ${result.itemsAfter} 条。`,
      );
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function undo(entry: MergeJournal) {
    if (!window.confirm("撤销这次合并？目标条目会恢复，候选会回到队列。")) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await api(`/api/merge/${encodeURIComponent(entry.id)}/undo`, { method: "POST" });
      setMessage("已撤销");
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const grade = health?.grade ?? "warn";
  const gradeLabel =
    grade === "good" ? "健康" : grade === "ok" ? "可用" : grade === "warn" ? "注意" : "需处理";

  return (
    <div className="health">
      <div className="kpis">
        <div className="kpi"><span>健康分</span><b className={`health-score ${grade}`}>{health?.score ?? "—"}</b></div>
        <div className="kpi"><span>容量</span><b>{formatPercent(health?.details.capacityRatio ?? 0)}</b></div>
        <div className="kpi"><span>重复率</span><b className="warn">{formatPercent(health?.details.duplicateRate ?? 0)}</b></div>
        <div className="kpi"><span>建议采纳率</span><b className="good">{formatPercent(health?.details.suggestionAcceptance ?? 1)}</b></div>
      </div>

      {message ? <div className="banner ok">{message}</div> : null}
      {error ? <div className="banner error">{error}</div> : null}

      <div className="health-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>记忆健康</h2>
            <span className={`badge ${grade === "good" ? "success" : grade === "bad" ? "error" : "warning"}`}>
              {gradeLabel}
            </span>
            <button className="btn" disabled={busy} onClick={() => void compact()} type="button">
              {busy ? "处理中…" : "运行压缩"}
            </button>
            <button className="btn ghost" onClick={() => void load()} type="button">刷新</button>
          </div>
          <div className="detail-body">
            <div className={`health-hero ${grade}`}>
              <div className="score">{health?.score ?? "—"}</div>
              <div>
                <strong>{gradeLabel}</strong>
                <div className="muted small">
                  容量、重复、冲突、误报、队列年龄、降级、建议采纳与撤销的综合得分。
                </div>
              </div>
            </div>
            <div className="breakdown">
              {BREAKDOWN_LABELS.map(([key, label]) => (
                <Bar key={key} label={label} value={health?.breakdown[key] ?? 0} />
              ))}
            </div>
            <div className="health-facts">
              <span>条目 {health?.details.items ?? 0}</span>
              <span>队列 {health?.details.queue ?? 0}</span>
              <span>Shadow {health?.details.shadow ?? 0}</span>
              <span>冲突 {health?.details.conflictCount ?? 0}</span>
              <span>队列 p95 {health?.details.queueAgeP95Hours ?? 0}h</span>
              <span>撤销 {health?.details.undoCount ?? 0}</span>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head"><h2>模型调用</h2><span className="meta">近 30 天</span></div>
          <div className="detail-body">
            <div className="usage-row">
              <div>
                <span className="muted small">System One</span>
                <b>{usage?.decisionCalls ?? 0} 次</b>
              </div>
              <div>
                <span className="muted small">tokens</span>
                <b>{usage?.decisionTokens ?? 0}</b>
              </div>
              <div>
                <span className="muted small">降级</span>
                <b className={(usage?.decisionFallbackRate ?? 0) > 0.2 ? "sev-error" : ""}>
                  {formatPercent(usage?.decisionFallbackRate ?? 0)}
                </b>
              </div>
            </div>
            <div className="usage-row">
              <div>
                <span className="muted small">System Two</span>
                <b>{usage?.rewriteCalls ?? 0} 次</b>
              </div>
              <div>
                <span className="muted small">tokens</span>
                <b>{usage?.rewriteTokens ?? 0}</b>
              </div>
              <div>
                <span className="muted small">降级</span>
                <b className={(usage?.rewriteFallbackRate ?? 0) > 0.2 ? "sev-error" : ""}>
                  {formatPercent(usage?.rewriteFallbackRate ?? 0)}
                </b>
              </div>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              降级 = 模型不可用/超限/输出不合格时走 heuristic 或模板合并；不会阻塞队列。
            </p>
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head"><h2>最近合并</h2><span className="meta">24h 内可撤销</span></div>
        {journal.length === 0 ? (
          <div className="empty">还没有合并记录。</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>时间</th><th>动作</th><th>目标</th><th>状态</th><th /></tr>
              </thead>
              <tbody>
                {journal.map((entry) => {
                  const undoable =
                    !entry.undone &&
                    Date.now() - new Date(entry.at).getTime() <= 24 * 60 * 60 * 1000;
                  return (
                    <tr key={entry.id}>
                      <td className="muted">{formatAge(entry.at)}</td>
                      <td><span className="badge">{entry.action}</span></td>
                      <td className="muted">{entry.targetID ?? "—"}</td>
                      <td>{entry.undone ? <span className="badge">已撤销</span> : <span className="badge success">已应用</span>}</td>
                      <td>
                        <button
                          className="btn"
                          disabled={!undoable || busy}
                          onClick={() => void undo(entry)}
                          type="button"
                        >
                          撤销
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  const width = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="track"><div className="fill" style={{ width }} /></div>
      <span>{Math.round(value * 100)}</span>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
