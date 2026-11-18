import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type {
  GraphNode,
  GraphSource,
  GraphSourceDetail,
  MemoryGraphData,
  MemoryGraphView,
} from "../types";
import { queueItemLink } from "./audit-links";
import {
  GRAPH_VIEWS,
  authorityLabel,
  edgeLabel,
  filterInventory,
  formatBytes,
  graphViewLink,
  groupSources,
  inventoryCounts,
  layerOrder,
  stateLabel,
  stateTone,
} from "./memory-graph";
import { MapView } from "./MapView";

interface Props {
  refreshKey: number;
  view: MemoryGraphView;
  onViewChange: (view: MemoryGraphView) => void;
}

export function MemoryGraph({ refreshKey, view, onViewChange }: Props) {
  const [data, setData] = useState<MemoryGraphData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<GraphSourceDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const requestSeq = useRef(0);
  const detailSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    api<MemoryGraphData>("/api/graph")
      .then((next) => {
        if (seq !== requestSeq.current) return;
        setData(next);
        setError("");
      })
      .catch((caught: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(errorMessage(caught));
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (view === "similarity") {
      setLoading(false);
      return;
    }
    load();
  }, [refreshKey, view, load]);

  const openSource = useCallback((source: GraphSource) => {
    if (!source.path) return;
    const seq = ++detailSeq.current;
    setDetailLoading(true);
    setDetail(undefined);
    setDetailError("");
    api<GraphSourceDetail>(`/api/graph/source?id=${encodeURIComponent(source.id)}`)
      .then((next) => {
        if (seq !== detailSeq.current) return;
        setDetail(next);
        window.setTimeout(() => {
          const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          document.querySelector(".source-detail")?.scrollIntoView({
            behavior: reduce ? "auto" : "smooth",
            block: "start",
          });
        }, 0);
      })
      .catch((caught: unknown) => {
        if (seq !== detailSeq.current) return;
        setDetailError(errorMessage(caught));
      })
      .finally(() => {
        if (seq === detailSeq.current) setDetailLoading(false);
      });
  }, []);

  const changeView = (next: MemoryGraphView) => {
    setDetail(undefined);
    setDetailError("");
    onViewChange(next);
    window.location.hash = graphViewLink(next);
  };

  return (
    <section className="graph-page" aria-label="记忆图谱">
      <header className="graph-head">
        <div>
          <h2>记忆图谱</h2>
          <p className="muted">
            只读视图：架构、实际记忆、路由、自动化与备份状态。正文按需读取。
          </p>
        </div>
        <div className="graph-head-meta">
          {data?.project ? <span className="chip">当前实例 · {data.project.label}</span> : <span className="chip">项目身份未知</span>}
          {data ? <span className="muted">读取于 {new Date(data.generatedAt).toLocaleTimeString()}</span> : null}
          <button className="btn ghost" type="button" onClick={load} disabled={loading}>
            {loading ? "读取中…" : "重新读取"}
          </button>
        </div>
      </header>

      <div className="view-switch" role="tablist" aria-label="记忆图谱视图">
        {GRAPH_VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={view === entry.id}
            className={`view-switch-btn${view === entry.id ? " active" : ""}`}
            title={entry.description}
            onClick={() => changeView(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {view === "similarity" ? (
        <div className="graph-similarity">
          <p className="muted">
            相似性探索是 OpenMem 条目的词面向量投影，不是完整架构图；关闭它不影响其他视图。
          </p>
          <MapView refreshKey={refreshKey} onChanged={load} />
        </div>
      ) : (
        <>
          {loading && !data ? (
            <div className="banner ok" role="status">正在读取记忆图谱…</div>
          ) : null}
          {error ? (
            <div className="banner error" role="alert">
              {error}
              <button className="btn ghost" type="button" onClick={load}>重试</button>
            </div>
          ) : null}
          {!data && !loading && !error ? (
            <div className="empty">没有可显示的图谱数据。</div>
          ) : null}
          {data ? (
            <>
              {view === "architecture" ? (
                <ArchitectureView data={data} onOpenSource={openSource} />
              ) : null}
              {view === "inventory" ? <InventoryView data={data} onSimilarity={() => changeView("similarity")} /> : null}
              {view === "routing" ? <RoutingView data={data} /> : null}
              {view === "automation" ? <AutomationView data={data} /> : null}
              {view === "backup" ? <BackupView data={data} /> : null}
              {detailLoading ? (
                <div className="banner ok" role="status">正在读取来源…</div>
              ) : null}
              {detailError ? <div className="banner error" role="alert">{detailError}</div> : null}
              {detail ? <SourceDetail detail={detail} onClose={() => setDetail(undefined)} /> : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function ArchitectureView({
  data,
  onOpenSource,
}: {
  data: MemoryGraphData;
  onOpenSource: (source: GraphSource) => void;
}) {
  const layers = useMemo(
    () =>
      data.views.architecture.nodes
        .filter((node) => node.kind === "layer")
        .slice()
        .sort((left, right) => layerOrder(left) - layerOrder(right)),
    [data],
  );
  const groups = useMemo(() => groupSources(data.sources), [data.sources]);
  const byID = useMemo(
    () => new Map(data.views.architecture.nodes.map((node) => [node.id, node.title])),
    [data.views.architecture.nodes],
  );

  return (
    <div className="graph-grid">
      <section className="panel">
        <div className="panel-head">
          <h2>层与权威</h2>
          <span className="meta">L0 → L2 → L1 → 暂定</span>
        </div>
        <div className="layer-list">
          {layers.map((node) => (
            <article className="layer-card" key={node.id}>
              <div className="layer-card-head">
                <strong>{node.title}</strong>
                <span className={`badge ${toneClass(node.status)}`}>{stateLabel(asState(node.status))}</span>
              </div>
              <div className="chips">
                <span className="chip">{String(node.meta?.sources ?? 0)} 个来源</span>
                <span className="chip">{String(node.meta?.files ?? 0)} 个文件</span>
                {Number(node.meta?.entries ?? 0) > 0 ? (
                  <span className="chip">{String(node.meta?.entries)} 条</span>
                ) : null}
                <span className="chip">{authorityLabel(asAuthority(node.meta?.authority))}</span>
              </div>
            </article>
          ))}
        </div>
        <div className="graph-edges">
          <h3>权威关系</h3>
          {data.views.architecture.edges.map((entry, index) => (
            <div className="graph-edge" key={`${entry.source}-${entry.target}-${index}`}>
              <span>{byID.get(entry.source) ?? entry.source}</span>
              <b>→</b>
              <span>{byID.get(entry.target) ?? entry.target}</span>
              <em>{entry.label ?? entry.relation}</em>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>来源目录</h2>
          <span className="meta">只读；正文按需读取</span>
        </div>
        {groups.map((group) => (
          <div className="source-group" key={group.layer}>
            <h3>{group.label}</h3>
            {group.sources.map((source) => (
              <div className="source-row" key={source.id}>
                <div className="source-main">
                  <strong>{source.label}</strong>
                  {source.path ? <span className="source-path mono">{source.path}</span> : null}
                  <div className="chips">
                    <span className={`badge ${toneClass(source.state)}`}>{stateLabel(source.state)}</span>
                    <span className="chip">{authorityLabel(source.authority)}</span>
                    {source.files !== undefined ? <span className="chip">{source.files} 文件</span> : null}
                    {source.entries !== undefined ? <span className="chip">{source.entries} 条</span> : null}
                    {source.bytes !== undefined ? <span className="chip">{formatBytes(source.bytes)}</span> : null}
                  </div>
                  {source.note ? <span className="muted">{source.note}</span> : null}
                </div>
                {source.path && source.state !== "missing" && source.state !== "unknown" ? (
                  <button className="btn ghost" type="button" onClick={() => onOpenSource(source)}>
                    查看
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

function InventoryView({
  data,
  onSimilarity,
}: {
  data: MemoryGraphData;
  onSimilarity: () => void;
}) {
  const nodes = data.views.inventory.nodes;
  const counts = useMemo(() => inventoryCounts(nodes), [nodes]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [scope, setScope] = useState("");
  const filtered = useMemo(
    () => filterInventory(nodes, { query, status, kind, scope }),
    [nodes, query, status, kind, scope],
  );
  const nodeByID = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>记忆条目</h2>
          <span className="meta">
            {String(data.views.inventory.summary.shown)} / {String(data.views.inventory.summary.total)} 条
          </span>
        </div>
        <button className="btn ghost" type="button" onClick={onSimilarity}>相似性探索</button>
      </div>
      {data.views.inventory.summary.truncated ? (
        <div className="banner warning">条目过多，当前只显示前 500 条；请用队列或审计页面查看完整列表。</div>
      ) : null}
      <div className="toolbar graph-filters">
        <input
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题、ID、类型…"
          aria-label="搜索记忆条目"
        />
        <select className="select" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="按状态筛选">
          <option value="">全部状态</option>
          {counts.statuses.map((entry) => (
            <option key={entry.value} value={entry.value}>{entry.value} ({entry.count})</option>
          ))}
        </select>
        <select className="select" value={kind} onChange={(event) => setKind(event.target.value)} aria-label="按类型筛选">
          <option value="">全部类型</option>
          {counts.kinds.map((entry) => (
            <option key={entry.value} value={entry.value}>{entry.value} ({entry.count})</option>
          ))}
        </select>
        <select className="select" value={scope} onChange={(event) => setScope(event.target.value)} aria-label="按范围筛选">
          <option value="">全部范围</option>
          {counts.scopes.map((entry) => (
            <option key={entry.value} value={entry.value}>{entry.value} ({entry.count})</option>
          ))}
        </select>
      </div>
      {data.groups && data.groups.length > 0 ? (
        <details className="graph-details">
          <summary>整理候选组 ({data.groups.length}) · 只读，不合并、不删除</summary>
          <div className="group-list">
            {data.groups.map((group) => (
              <div className="group-row" key={group.id}>
                <span className={`badge ${groupTone(group.relation)}`}>{groupLabel(group.relation)}</span>
                <span>{group.nodeIds.map((id) => nodeByID.get(id)?.title ?? id).join(" · ")}</span>
                <span className="muted">{group.nodeIds.length} 条</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {filtered.length === 0 ? (
        <div className="empty">
          没有匹配的条目。
          <button className="btn ghost" type="button" onClick={() => { setQuery(""); setStatus(""); setKind(""); setScope(""); }}>
            清除筛选
          </button>
        </div>
      ) : (
        <div className="table-wrap">
          <table aria-label="记忆条目">
            <thead>
              <tr>
                <th>标题</th>
                <th>类型</th>
                <th>范围</th>
                <th>状态</th>
                <th>优先级</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((node) => {
                const id = String(node.meta?.id ?? node.id.replace(/^inv:/, ""));
                return (
                  <tr key={node.id}>
                    <td>
                      {node.status === "queue"
                        ? <a href={queueItemLink(id)}>{node.title}</a>
                        : node.title}
                    </td>
                    <td><span className="badge">{node.kind}</span></td>
                    <td>{node.scope ?? "—"}</td>
                    <td><span className={`badge ${statusTone(node.status)}`}>{node.status ?? "—"}</span></td>
                    <td className="mono">{String(node.meta?.priority ?? 0)}</td>
                    <td className="mono source-path">{id}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RoutingView({ data }: { data: MemoryGraphData }) {
  const nodes = data.views.routing.nodes;
  const edges = data.views.routing.edges;
  const byID = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const routes = useMemo(() => {
    return edges
      .filter((entry) => entry.relation === "matches")
      .map((match) => {
        const signal = byID.get(match.target);
        const read = edges.find(
          (entry) => entry.source === match.target && entry.relation === "reads",
        );
        const target = read ? byID.get(read.target) : undefined;
        return signal && target ? { signal, target } : undefined;
      })
      .filter((entry): entry is { signal: GraphNode; target: GraphNode } => Boolean(entry));
  }, [edges, byID]);
  const staticNodes = ["route:start", "route:agents", "route:matrix"]
    .map((id) => byID.get(id))
    .filter((node): node is GraphNode => Boolean(node));

  return (
    <div className="graph-grid">
      <section className="panel">
        <div className="panel-head">
          <h2>启动路径</h2>
          <span className={`badge ${toneClass(String(data.views.routing.summary.source))}`}>
            {stateLabel(asState(String(data.views.routing.summary.source)))}
          </span>
        </div>
        <div className="flow-row">
          {staticNodes.map((node, index) => (
            <span className="flow-step" key={node.id}>
              {index > 0 ? <b aria-hidden="true">→</b> : null}
              <span>{node.title}</span>
            </span>
          ))}
        </div>
        <p className="muted">
          这里展示的是 AGENTS.md 的 Root Trigger Matrix 与实际读取目标；规则冲突时仍以 L0/L2 为准。
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>触发路由</h2>
          <span className="meta">{String(data.views.routing.summary.routes)} 条</span>
        </div>
        {routes.length === 0 ? (
          <div className="banner warning">
            未找到 Root Trigger Matrix。请检查 AGENTS.md 是否存在，或矩阵标题是否仍为 “Root Trigger Matrix”。
          </div>
        ) : (
          <div className="route-list">
            {routes.map(({ signal, target }) => (
              <div className="route-row" key={signal.id}>
                <span className="route-signal">{signal.title}</span>
                <b aria-hidden="true">→</b>
                <span className="route-target">{target.title}</span>
              </div>
            ))}
          </div>
        )}
        {edges.length > 0 ? (
          <details className="graph-details">
            <summary>查看全部路由边 ({edges.length})</summary>
            <div className="graph-edges">
              {edges.map((entry, index) => (
                <div className="graph-edge" key={`${entry.source}-${entry.target}-${index}`}>
                  <span>{edgeLabel(nodes, entry)}</span>
                  <em>{entry.label ?? entry.relation}</em>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}

function AutomationView({ data }: { data: MemoryGraphData }) {
  const steps = data.views.automation.nodes.filter((node) => node.kind === "step");
  const promotion = data.views.automation.nodes.filter((node) => node.kind === "promotion");
  const summary = data.views.automation.summary;
  return (
    <div className="graph-grid">
      <section className="panel">
        <div className="panel-head">
          <h2>自动化管线</h2>
          <span className="meta">候选 → 分类 → 去重 → 路由 → 审批</span>
        </div>
        <div className="flow-row">
          {steps.map((node, index) => (
            <span className="flow-step" key={node.id}>
              {index > 0 ? <b aria-hidden="true">→</b> : null}
              <span>
                {node.title}
                <small>{node.meta ? Object.entries(node.meta).map(([key, value]) => `${key} ${value}`).join(" · ") : ""}</small>
              </span>
            </span>
          ))}
        </div>
        <div className="kpis graph-kpis">
          <div className="kpi"><span>Hooks</span><strong>{String(summary.hooks ?? 0)}</strong></div>
          <div className="kpi"><span>待处理</span><strong>{String(summary.pending ?? 0)}</strong></div>
          <div className="kpi"><span>队列</span><strong>{String(summary.queue ?? 0)}</strong></div>
          <div className="kpi"><span>Shadow</span><strong>{String(summary.shadow ?? 0)}</strong></div>
          <div className="kpi"><span>复盘</span><strong>{String(summary.reviews ?? 0)}</strong></div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>规则晋升</h2>
          <span className="badge warning">需确认</span>
        </div>
        <div className="promotion-lane">
          {promotion.map((node, index) => (
            <span className="promotion-step" key={node.id}>
              {index > 0 ? <b aria-hidden="true">→</b> : null}
              <span>
                {node.title}
                {node.meta?.target ? <small>目标 {String(node.meta.target)}</small> : null}
              </span>
            </span>
          ))}
        </div>
        <p className="muted">
          OpenMem 候选进入队列只代表“可审查”；L1 → L0/L2 的规则晋升仍须 PENDING 和用户确认，二者不是同一条自动路径。
        </p>
        <div className="graph-links">
          <a className="btn ghost" href="#queue">打开审批队列</a>
          <a className="btn ghost" href="#health">打开健康与恢复</a>
        </div>
      </section>
    </div>
  );
}

const INTEGRITY_LABEL: Record<string, string> = {
  verified: "已校验",
  partial: "结构已知",
  corrupt: "损坏",
  unknown: "未知",
};
const FRESHNESS_LABEL: Record<string, string> = {
  fresh: "新鲜",
  stale: "过期",
  unknown: "未知",
};
const RESTORE_LABEL: Record<string, string> = {
  automatic: "自动",
  manual: "手动",
  none: "无",
  unknown: "未演练 / 未知",
};
const DOMAIN_STATE_LABEL: Record<string, string> = {
  present: "已备份",
  missing: "缺失",
  unknown: "未知",
};

function integrityTone(value: string): string {
  if (value === "verified") return "success";
  if (value === "corrupt") return "error";
  return "warning";
}

function freshnessTone(value: string): string {
  return value === "fresh" ? "success" : "warning";
}

function restoreTone(value: string): string {
  if (value === "automatic") return "success";
  if (value === "manual") return "info";
  if (value === "none") return "error";
  return "warning";
}

function domainStateTone(value: string): string {
  if (value === "present") return "success";
  if (value === "missing") return "warning";
  return "info";
}

function BackupView({ data }: { data: MemoryGraphData }) {
  const status = data.backup;
  const nodes = data.views.backup.nodes;
  const fallbackDomains = nodes
    .filter((node) => node.kind === "domain")
    .map((node) => ({
      id: String(node.id),
      label: node.title,
      state:
        node.status === "ready"
          ? "present"
          : node.status === "missing"
            ? "missing"
            : "unknown",
      integrity: String(node.meta?.integrity ?? "unknown"),
      freshness: String(node.meta?.freshness ?? "unknown"),
      restoreSupport: String(node.meta?.restore ?? "unknown"),
      present: [] as string[],
      required: [] as string[],
      missing: [] as string[],
      notes: [] as string[],
    }));
  const domains = status?.domains ?? fallbackDomains;
  const latest = status?.latest;
  const latestComplete = status?.latestComplete;
  const coverage = status?.coverage ?? {
    required: 5,
    present: 0,
    missing: [],
    unknown: [],
  };
  const drill = status?.restoreDrill;
  const incomplete = latest !== undefined && latest.complete !== true;
  return (
    <div className="graph-grid">
      <section className="panel">
        <div className="panel-head">
          <h2>最新备份</h2>
          <span
            className={`badge ${!status?.snapshotPresent ? "warning" : latest?.complete === true ? "success" : "warning"}`}
          >
            {!status?.snapshotPresent
              ? "未找到备份"
              : latest?.complete === true
                ? "结构完整"
                : "结构不完整"}
          </span>
        </div>
        <p className="source-path mono">
          {latest?.dir ?? "未找到 backup-* 目录"}
        </p>
        <div className="chips">
          <span className="chip">
            覆盖 {coverage.present} / {coverage.required} 个域
          </span>
          <span className={`chip`}>
            完整性 {INTEGRITY_LABEL[status?.integrity ?? "unknown"]}
          </span>
          <span className="chip">
            新鲜度 {FRESHNESS_LABEL[status?.freshness ?? "unknown"]}
          </span>
          <span className="chip">
            恢复能力 {RESTORE_LABEL[status?.restoreSupport ?? "unknown"]}
          </span>
          <span className="chip">
            演练{" "}
            {status?.drillStatus === "passed"
              ? "通过"
              : status?.drillStatus === "failed"
                ? "失败"
                : status?.drillStatus === "invalid"
                  ? "记录无效"
                  : "未演练"}
          </span>
        </div>
        {incomplete ? (
          <div className="banner warning" role="status">
            最新快照结构不完整。
            {latestComplete
              ? ` 最近结构完整快照：${latestComplete.name}。`
              : " 没有更早的结构完整快照。"}
            结构完整不等于可恢复。
          </div>
        ) : null}
        {status && status.snapshotPresent && !status.manifestPresent ? (
          <div className="banner warning" role="status">
            没有 manifest，完整性未知；备份存在不等于可恢复。
          </div>
        ) : null}
        {status && status.snapshotPresent && status.drillStatus === "missing" ? (
          <div className="banner warning" role="status">
            未演练恢复；恢复能力显示为未知，不显示“已验证”。
          </div>
        ) : null}
        {status && status.drillStatus === "invalid" ? (
          <div className="banner warning" role="status">
            演练记录无法解析或属于其他快照；恢复能力按未知处理。
          </div>
        ) : null}
        {coverage.missing.length > 0 ? (
          <p className="muted small">缺失：{coverage.missing.join("、")}</p>
        ) : null}
        {coverage.unknown.length > 0 ? (
          <p className="muted small">未知：{coverage.unknown.join("、")}</p>
        ) : null}
        <a className="btn ghost" href="#health">
          在健康页查看撤销与清理
        </a>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>覆盖矩阵</h2>
          <span className="meta">存在 / 完整性 / 新鲜度 / 恢复</span>
        </div>
        <div className="table-wrap">
          <table aria-label="备份与恢复覆盖">
            <thead>
              <tr>
                <th>域</th>
                <th>存在</th>
                <th>完整性</th>
                <th>新鲜度</th>
                <th>恢复能力</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((domain) => (
                <tr key={domain.id}>
                  <td>
                    <div>{domain.label}</div>
                    {domain.notes.length > 0 ? (
                      <div className="muted small">
                        {domain.notes.slice(0, 2).join("；")}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={`badge ${domainStateTone(domain.state)}`}
                    >
                      {DOMAIN_STATE_LABEL[domain.state] ?? "未知"}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${integrityTone(domain.integrity)}`}>
                      {INTEGRITY_LABEL[domain.integrity] ?? "未知"}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${freshnessTone(domain.freshness)}`}>
                      {FRESHNESS_LABEL[domain.freshness] ?? "未知"}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${restoreTone(domain.restoreSupport)}`}
                    >
                      {RESTORE_LABEL[domain.restoreSupport] ?? "未演练 / 未知"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {status?.notes.length ? (
          <details className="muted small">
            <summary>状态说明</summary>
            <ul>
              {status.notes.slice(0, 8).map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    </div>
  );
}

function SourceDetail({ detail, onClose }: { detail: GraphSourceDetail; onClose: () => void }) {
  return (
    <section className="panel source-detail" aria-label="来源详情">
      <div className="panel-head">
        <div>
          <h2>{detail.label}</h2>
          <span className="source-path mono">{detail.path}</span>
        </div>
        <button className="btn ghost" type="button" onClick={onClose}>关闭</button>
      </div>
      {detail.headings.length > 0 ? (
        <div className="chips">
          {detail.headings.map((heading) => <span className="chip" key={heading}>{heading}</span>)}
        </div>
      ) : null}
      {detail.files && detail.files.length > 0 ? (
        <div className="source-files">
          {detail.files.map((file) => (
            <div className="source-file" key={file.name}>
              <span>{file.name}</span>
              <span className="muted">{formatBytes(file.bytes)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {detail.excerpt ? (
        <pre className="source-excerpt">{detail.excerpt}{detail.truncated ? "\n…" : ""}</pre>
      ) : null}
    </section>
  );
}

function toneClass(value?: string): string {
  const tone = stateTone(asState(value));
  return tone ?? "";
}

function statusTone(value?: string): string {
  if (value === "auto" || value === "promoted") return "success";
  if (value === "queue") return "warning";
  if (value === "shadow") return "info";
  if (value === "false_positive") return "error";
  return "";
}

function groupLabel(relation: "exact" | "covered" | "classification-mismatch" | "conflict"): string {
  if (relation === "exact") return "完全重复";
  if (relation === "covered") return "已被覆盖";
  if (relation === "classification-mismatch") return "分类不一致";
  return "数值或极性冲突";
}

function groupTone(relation: "exact" | "covered" | "classification-mismatch" | "conflict"): string {
  if (relation === "conflict") return "error";
  if (relation === "classification-mismatch") return "warning";
  if (relation === "covered") return "info";
  return "";
}

function asState(value?: string): "ready" | "disabled" | "missing" | "unreadable" | "partial" | "stale" | "unknown" {
  switch (value) {
    case "ready":
    case "disabled":
    case "missing":
    case "unreadable":
    case "partial":
    case "stale":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function asAuthority(value: unknown): GraphSource["authority"] {
  switch (value) {
    case "authoritative":
    case "derived":
    case "tentative":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
