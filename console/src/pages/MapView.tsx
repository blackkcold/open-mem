import { useEffect, useMemo, useState } from "react";
import { api, formatPercent } from "../api";
import type { MapData, MapNode, Metrics } from "../types";

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

  useEffect(() => {
    Promise.all([api<MapData>("/api/map"), api<Metrics>("/api/metrics")])
      .then(([nextData, nextMetrics]) => {
        setData(nextData);
        setMetrics(nextMetrics);
        setError("");
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, [refreshKey]);

  const visible = useMemo(
    () => (data?.nodes ?? []).filter((node) => filter === "all" || node.status === filter),
    [data, filter],
  );
  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);
  const selected = data?.nodes.find((node) => node.id === selectedId) ?? null;

  async function markFalsePositive(node: MapNode) {
    const ok = window.confirm("Mark this shadow decision as a false positive?");
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
        <div className="kpi"><span>Auto applied</span><b className="good">{metrics?.auto ?? 0}</b></div>
        <div className="kpi"><span>Queue</span><b className="warn">{metrics?.queue ?? 0}</b></div>
        <div className="kpi"><span>Shadow</span><b>{metrics?.shadow ?? 0}</b></div>
        <div className="kpi"><span>False positive</span><b className="warn">{formatPercent(metrics?.falsePositiveRate ?? 0)}</b></div>
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
          {visible.length === 0 ? (
            <div className="empty">No nodes for this filter.</div>
          ) : (
            <svg className="map-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Memory point cloud">
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
                <circle
                  key={node.id}
                  data-node-id={node.id}
                  data-status={node.status}
                  cx={px(node.x)}
                  cy={py(node.y)}
                  r={5 + ((node.priority ?? 0) / 100) * 4}
                  fill={colorOf(node.status)}
                  fillOpacity={node.status === "shadow" ? 0.35 : 0.85}
                  stroke={node.id === selectedId ? "var(--text)" : "var(--panel)"}
                  strokeWidth={node.id === selectedId ? 2 : 1}
                  onClick={() => setSelectedId(node.id)}
                  style={{ cursor: "pointer" }}
                >
                  <title>{`${node.title} · ${node.status}`}</title>
                </circle>
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
            <div className="empty">Click a point to inspect the memory, its status, and Jev reasons.</div>
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
                Point cloud is an approximate 2D projection of text vectors. Use it for navigation, not as truth.
              </div>
              {selected.status === "shadow" ? (
                <button className="btn danger" onClick={() => void markFalsePositive(selected)} type="button">
                  Mark false positive
                </button>
              ) : null}
              {selected.status === "queue" ? (
                <p className="muted" style={{ margin: 0, fontSize: "0.72rem" }}>
                  This item is waiting in the Queue tab for approval.
                </p>
              ) : null}
              {selected.status === "auto" ? (
                <p className="muted" style={{ margin: 0, fontSize: "0.72rem" }}>
                  Auto-applied to AUTO_MEMORY / AUTO_RULES. Promote to curated L0 after review.
                </p>
              ) : null}
            </div>
          )}
        </aside>
      </div>
      <p className="muted" style={{ fontSize: "0.68rem", marginTop: 10 }}>
        Queue age p50/p95: {metrics?.queueAgeP50Hours ?? 0}h / {metrics?.queueAgeP95Hours ?? 0}h · Skill drafts: {metrics?.skillDrafts ?? 0} · Audit findings: {metrics?.auditFindings ?? 0}
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
