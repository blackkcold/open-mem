import type {
  GraphNode,
  GraphSource,
  MemoryGraphState,
  MemoryGraphView,
} from "../types";

export const GRAPH_VIEWS: Array<{
  id: MemoryGraphView;
  label: string;
  description: string;
}> = [
  { id: "architecture", label: "架构", description: "L0–L3、OpenMem 与派生视图" },
  { id: "inventory", label: "记忆", description: "条目、队列与 Shadow" },
  { id: "routing", label: "路由", description: "触发矩阵与读取路径" },
  { id: "automation", label: "自动化", description: "捕获、审批与晋升" },
  { id: "backup", label: "备份", description: "备份覆盖与恢复缺口" },
  { id: "similarity", label: "相似性", description: "词面向量点云（探索）" },
];

export const GRAPH_VIEW_IDS = new Set<MemoryGraphView>(
  GRAPH_VIEWS.map((view) => view.id),
);

export function isMemoryGraphView(value: string): value is MemoryGraphView {
  return GRAPH_VIEW_IDS.has(value as MemoryGraphView);
}

export function graphViewLink(view: MemoryGraphView): string {
  return `#map/${view}`;
}

export function stateLabel(state: MemoryGraphState): string {
  switch (state) {
    case "ready":
      return "可用";
    case "disabled":
      return "已关闭";
    case "missing":
      return "缺失";
    case "unreadable":
      return "不可读";
    case "partial":
      return "部分可用";
    case "stale":
      return "已过期";
    case "unknown":
      return "未知";
  }
}

export function stateTone(
  state: MemoryGraphState,
): "success" | "warning" | "error" | "info" | undefined {
  if (state === "ready") return "success";
  if (state === "disabled" || state === "missing" || state === "partial" || state === "stale") {
    return "warning";
  }
  if (state === "unreadable") return "error";
  return "info";
}

export function authorityLabel(authority: GraphSource["authority"]): string {
  switch (authority) {
    case "authoritative":
      return "权威";
    case "derived":
      return "派生";
    case "tentative":
      return "暂定";
    case "unknown":
      return "未知";
  }
}

export function layerLabel(layer: GraphSource["layer"]): string {
  switch (layer) {
    case "OpenMem":
      return "OpenMem";
    case "LogicChain":
      return "逻辑链图";
    case "Backup":
      return "备份";
    default:
      return layer;
  }
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

export function groupSources(
  sources: GraphSource[],
): Array<{ layer: GraphSource["layer"]; label: string; sources: GraphSource[] }> {
  const order: Array<GraphSource["layer"]> = [
    "L0",
    "L1",
    "L2",
    "L3",
    "OpenMem",
    "LogicChain",
    "Backup",
  ];
  return order
    .map((layer) => ({
      layer,
      label: layerLabel(layer),
      sources: sources.filter((source) => source.layer === layer),
    }))
    .filter((group) => group.sources.length > 0);
}

export function layerOrder(node: GraphNode): number {
  const order = ["L0", "L1", "L2", "L3", "OpenMem", "LogicChain", "Backup"];
  const index = node.layer ? order.indexOf(node.layer) : -1;
  return index >= 0 ? index : order.length;
}

export function filterInventory(
  nodes: GraphNode[],
  filters: { query?: string; status?: string; kind?: string; scope?: string },
): GraphNode[] {
  const query = filters.query?.trim().toLowerCase() ?? "";
  return nodes.filter((node) => {
    if (filters.status && node.status !== filters.status) return false;
    if (filters.kind && node.kind !== filters.kind) return false;
    if (filters.scope && node.scope !== filters.scope) return false;
    if (query && !`${node.title} ${node.kind} ${node.scope} ${node.status} ${String(node.meta?.id ?? "")}`
      .toLowerCase()
      .includes(query)) {
      return false;
    }
    return true;
  });
}

export function inventoryCounts(nodes: GraphNode[]): {
  statuses: Array<{ value: string; count: number }>;
  kinds: Array<{ value: string; count: number }>;
  scopes: Array<{ value: string; count: number }>;
} {
  return {
    statuses: countsOf(nodes.map((node) => node.status ?? "unknown")),
    kinds: countsOf(nodes.map((node) => node.kind)),
    scopes: countsOf(nodes.map((node) => node.scope ?? "unknown")),
  };
}

function countsOf(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

export function edgeLabel(
  nodes: GraphNode[],
  edge: { source: string; target: string; relation: string; label?: string },
): string {
  const byID = new Map(nodes.map((node) => [node.id, node.title]));
  return `${byID.get(edge.source) ?? edge.source} → ${byID.get(edge.target) ?? edge.target}`;
}

export function nodeMeta(node: GraphNode, key: string): string {
  const value = node.meta?.[key];
  return value === undefined || value === "" ? "—" : String(value);
}
