import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatPercent } from "../api";
import { confirmAction } from "../extension/confirm";
import type { MapData, MapNode, Metrics } from "../types";
import { queueItemLink } from "./audit-links";

interface Props {
  refreshKey: number;
  onChanged: () => void;
}

const WIDTH = 760;
const HEIGHT = 420;
const PAD = 28;

const STATUSES = ["all", "auto", "queue", "shadow", "false_positive", "promoted"] as const;

export function MapView({ refreshKey, onChanged }: Props) {
  const [data, setData] = useState<MapData>();
  const [metrics, setMetrics] = useState<Metrics>();
  const [filter, setFilter] = useState<(typeof STATUSES)[number]>("all");
  const [showEdges, setShowEdges] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    Promise.all([api<MapData>("/api/map"), api<Metrics>("/api/metrics")])
      .then(([nextData, nextMetrics]) => {
        if (seq !== requestSeq.current) return;
        setData(nextData);
        setMetrics(nextMetrics);
        setError("");
      })
      .catch((caught: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(errorMessage(caught));
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [refreshKey]);

  const visible = useMemo(
    () => (data?.nodes ?? []).filter((node) => filter === "all" || node.status === filter),
    [data, filter],
  );
  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);
  const selected = visible.find((node) => node.id === selectedId) ?? null;

  async function markFalsePositive(node: MapNode) {
    const ok = await confirmAction({
      title: "标记为误报？",
      message: "这条 shadow 决策会被标记为误报，并更新指标。",
      confirmLabel: "标记",
      danger: true,
    });
    if (!ok) return;
    setError("");
    setMessage("");
    try {
      await api(`/api/shadow/${encodeURIComponent(node.id)}/false-positive`, { method: "POST" });
      setMessage("Marked false positive; metrics updated.");
      onChanged();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div>
      <div className="kpis">
        <div className="kpi"><span>Auto applied</span><b className="good">{metrics ? metrics.auto : "—"}</b></div>
        <div className="kpi"><span>Queue</span><b className="warn">{metrics ? metrics.queue : "—"}</b></div>
        <div className="kpi"><span>Shadow</span><b>{metrics ? metrics.shadow : "—"}</b></div>
        <div className="kpi"><span>False positive</span><b className="warn">{metrics ? formatPercent(metrics.falsePositiveRate) : "—"}</b></div>
      </div>

      {message ? <div className="banner ok">{message}</div> : null}
      {error ? <div className="banner error">{error}</div> : null}

      <div className="map-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>记忆地图 · Shadow</h2>
            <span className="meta">点云 · 近似投影</span>
          </div>
          <div className="toolbar">
            {STATUSES.map((status) => (
              <button
                key={status}
                className={`btn${filter === status ? " primary" : ""}`}
                aria-pressed={filter === status}
                onClick={() => setFilter(status)}
                type="button"
              >
                {status === "all" ? "全部" : status}
              </button>
            ))}
            <button className="btn" onClick={() => setShowEdges((value) => !value)} type="button">
              {showEdges ? "隐藏关系边" : "显示关系边"}
            </button>
          </div>
          {loading && !data ? (
            <div className="empty" role="status">载入点云…</div>
          ) : visible.length === 0 ? (
            <div className="empty">
              {data ? "当前筛选没有节点。" : "没有可显示的点云数据。"}
            </div>
          ) : (
            <svg className="map-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label="记忆地图，可使用 Tab 选择记忆点">
              {showEdges
                ? (data?.edges ?? []).map((edge) => {
                    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) return null;
                    const from = data?.nodes.find((node) => node.id === edge.source);
                    const to = data?.nodes.find((node) => node.id === edge.target);
                    if (!from || !to) return null;
                    return (
                      <line
                        key={`${edge.source}-${edge.target}`}
                        x1={px(from.x)}
                        y1={py(from.y)}
                        x2={px(to.x)}
                        y2={py(to.y)}
                        stroke={edge.relation === "duplicate" ? "var(--danger)" : "var(--border)"}
                        strokeWidth={edge.relation === "duplicate" ? 1.2 : 0.7}
                        opacity={0.55}
                      />
                    );
                  })
                : null}
              {visible.map((node) => (
                <g
                  key={node.id}
                  data-node-id={node.id}
                  data-status={node.status}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.title} · ${node.status}`}
                  onClick={() => setSelectedId(node.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(node.id); } }}
                  style={{ cursor: "pointer" }}
                >
                  <circle cx={px(node.x)} cy={py(node.y)} r={42} fill="transparent" />
                  <circle
                    cx={px(node.x)}
                    cy={py(node.y)}
                    r={5 + ((node.priority ?? 0) / 100) * 4}
                    fill={colorOf(node.status)}
                    fillOpacity={node.status === "shadow" ? 0.35 : 0.85}
                    stroke={node.id === selectedId ? "var(--text)" : "var(--panel)"}
                    strokeWidth={node.id === selectedId ? 2 : 1}
                    pointerEvents="none"
                    aria-hidden="true"
                  />
                  <title>{`${node.title} · ${node.status}`}</title>
                </g>
              ))}
            </svg>
          )}
          <div className="legend">
            <span><i className="dot" style={{ background: "var(--success)" }} />auto</span>
            <span><i className="dot" style={{ background: "var(--warning)" }} />queue</span>
            <span><i className="dot" style={{ background: "var(--muted)", opacity: 0.4 }} />shadow</span>
            <span><i className="dot" style={{ background: "var(--danger)" }} />false positive</span>
            <span><i className="dot" style={{ background: "var(--info)" }} />promoted</span>
          </div>
        </section>

        <aside className="panel">
          {!selected ? (
            <div className="empty">选择一个记忆点，查看标题、类型、范围和状态。</div>
          ) : (
            <div className="detail-body">
              <h2>{selected.title}</h2>
              <div className="chips">
                <span className="chip">{selected.kind}</span>
                <span className="chip">{selected.scope}</span>
                <span className={`badge ${selected.status === "false_positive" ? "error" : selected.status === "auto" ? "success" : "warning"}`}>
                  {selected.status}
                </span>
                <span className="chip">priority {selected.priority ?? 0}</span>
              </div>
              <div className="muted" style={{ fontSize: "0.72rem", lineHeight: 1.5 }}>
                点云是文本词面向量的近似二维投影，用于探索，不是事实判断。
              </div>
              {selected.status === "shadow" ? (
                <button className="btn danger" onClick={() => void markFalsePositive(selected)} type="button">
                  标记为误报
                </button>
              ) : null}
              {selected.status === "queue" ? (
                <a className="btn ghost" href={queueItemLink(selected.id)}>
                  打开审批条目
                </a>
              ) : null}
              {selected.status === "auto" ? (
                <p className="muted" style={{ margin: 0, fontSize: "0.72rem" }}>
                  已自动写入 AUTO_MEMORY / AUTO_RULES；复核后再晋升为 L0 规则。
                </p>
              ) : null}
            </div>
          )}
        </aside>
      </div>
      <p className="muted" style={{ fontSize: "0.68rem", marginTop: 10 }}>
        Queue age p50/p95: {metrics ? `${metrics.queueAgeP50Hours}h / ${metrics.queueAgeP95Hours}h` : "—"} · Skill drafts: {metrics ? metrics.skillDrafts : "—"} · Audit findings: {metrics ? metrics.auditFindings : "—"}
      </p>
    </div>
  );
}

function px(value: number): number {
  return PAD + value * (WIDTH - PAD * 2);
}

function py(value: number): number {
  return PAD + value * (HEIGHT - PAD * 2);
}

function colorOf(status: string): string {
  if (status === "auto") return "var(--success)";
  if (status === "queue") return "var(--warning)";
  if (status === "false_positive") return "var(--danger)";
  if (status === "promoted") return "var(--info)";
  return "var(--muted)";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
