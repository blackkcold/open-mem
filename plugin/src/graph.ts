import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Store } from "./store.js";
import type { Item, QueueItem, ShadowRecord } from "./types.js";
import { sha16 } from "./util/text.js";
import { sameScopeAndProject } from "./memory/scope.js";
import { classifyRelation, type RelationKind } from "./relations.js";

export type GraphLayer = "L0" | "L1" | "L2" | "L3" | "OpenMem" | "LogicChain" | "Backup";
export type GraphView =
  | "architecture"
  | "inventory"
  | "routing"
  | "automation"
  | "backup";
export type GraphState =
  | "ready"
  | "disabled"
  | "missing"
  | "unreadable"
  | "partial"
  | "stale"
  | "unknown";
export type GraphAuthority = "authoritative" | "derived" | "tentative" | "unknown";

export interface GraphSource {
  id: string;
  layer: GraphLayer;
  label: string;
  path?: string;
  scope: "global" | "project" | "session" | "mixed" | "unknown";
  authority: GraphAuthority;
  state: GraphState;
  files?: number;
  entries?: number;
  bytes?: number;
  updatedAt?: string;
  note?: string;
}

export interface GraphNode {
  id: string;
  view: GraphView;
  kind: string;
  title: string;
  layer?: string;
  scope?: string;
  status?: string;
  sourceId?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  label?: string;
}

export interface GraphViewData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  summary: Record<string, string | number | boolean>;
}

export interface MemoryGraphData {
  generatedAt: string;
  project?: { label: string; key: string };
  sources: GraphSource[];
  views: Record<GraphView, GraphViewData>;
  /** Lossless, read-only relation groups; no entry is rewritten or archived. */
  groups?: GraphGroup[];
}

export interface GraphGroup {
  id: string;
  relation: "exact" | "covered" | "classification-mismatch" | "conflict";
  title: string;
  nodeIds: string[];
}

export interface GraphRoots {
  opencodeDir: string;
  openchamberDir: string;
  backupRoot: string;
  logicChainDir: string;
  projectDir?: string;
}

export interface BuildGraphOptions {
  store: Store;
  projectDir?: string;
  roots?: Partial<GraphRoots>;
}

export interface GraphSourceDetail {
  id: string;
  label: string;
  path: string;
  state: GraphState;
  headings: string[];
  excerpt: string;
  truncated: boolean;
  files?: Array<{ name: string; bytes: number }>;
}

const MAX_FILES = 200;
const MAX_READ_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 20_000;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "archive",
  "ARCHIVED",
  "autopilot",
  "PENDING",
  "__pycache__",
]);

export function defaultGraphRoots(projectDir?: string): GraphRoots {
  const home = os.homedir();
  const backupRoot = path.join(home, "Documents", "Opencode project", "记忆备份");
  return {
    opencodeDir: path.join(home, ".config", "opencode"),
    openchamberDir: path.join(home, ".config", "openchamber"),
    backupRoot,
    logicChainDir: path.join(backupRoot, "逻辑链图"),
    projectDir,
  };
}

export interface FileInfo {
  path: string;
  name: string;
  bytes: number;
  updatedAt: string;
}

async function fileInfo(file: string): Promise<FileInfo | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    return {
      path: file,
      name: path.basename(file),
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string, maxBytes = MAX_READ_BYTES): Promise<string | undefined> {
  try {
    const buffer = await readFile(file);
    return buffer.subarray(0, maxBytes).toString("utf8");
  } catch {
    return undefined;
  }
}

export async function listMarkdownFiles(
  root: string,
  depth = 1,
): Promise<FileInfo[]> {
  return listMarkdown(root, depth);
}

export async function readTextFile(
  file: string,
  maxBytes = MAX_READ_BYTES,
): Promise<string | undefined> {
  return readText(file, maxBytes);
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function listMarkdown(root: string, depth = 1): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  async function walk(dir: string, level: number): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        if (level >= depth || SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), level + 1);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const info = await fileInfo(path.join(dir, entry.name));
        if (info) out.push(info);
      }
    }
  }
  await walk(root, 0);
  return out;
}

function countEntries(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["entries", "memories", "items"]) {
      if (Array.isArray(record[key])) return record[key].length;
    }
  }
  return undefined;
}

function sum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length > 0 ? present.reduce((total, value) => total + value, 0) : undefined;
}

const STATE_RANK: Record<GraphState, number> = {
  unreadable: 6,
  missing: 5,
  disabled: 4,
  partial: 3,
  stale: 2,
  unknown: 1,
  ready: 0,
};

function worstState(states: GraphState[]): GraphState {
  if (states.length === 0) return "missing";
  return states.reduce((worst, state) =>
    STATE_RANK[state] > STATE_RANK[worst] ? state : worst,
  );
}

function sourceStateForFile(info: FileInfo | undefined): GraphState {
  return info ? "ready" : "missing";
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

function layerNode(
  view: GraphView,
  layer: GraphLayer,
  sources: GraphSource[],
): GraphNode {
  const states = sources.map((source) => source.state);
  const authority =
    sources.find((source) => source.authority === "authoritative")?.authority ??
    sources[0]?.authority ??
    "unknown";
  return {
    id: `layer:${layer}`,
    view,
    kind: "layer",
    title: layer,
    layer,
    status: worstState(states),
    meta: {
      sources: sources.length,
      files: sum(sources.map((source) => source.files)) ?? 0,
      entries: sum(sources.map((source) => source.entries)) ?? 0,
      authority,
    },
  };
}

function edge(
  source: string,
  target: string,
  relation: string,
  label: string,
): GraphEdge {
  return { source, target, relation, label };
}

export async function buildMemoryGraph(
  options: BuildGraphOptions,
): Promise<MemoryGraphData> {
  const roots = { ...defaultGraphRoots(options.projectDir), ...options.roots };
  const projectDir = roots.projectDir ?? options.projectDir;
  const sources: GraphSource[] = [];

  const agentsInfo = await fileInfo(path.join(roots.opencodeDir, "AGENTS.md"));
  sources.push({
    id: "l0:agents",
    layer: "L0",
    label: "AGENTS.md",
    path: agentsInfo?.path,
    scope: "global",
    authority: "authoritative",
    state: sourceStateForFile(agentsInfo),
    files: agentsInfo ? 1 : 0,
    bytes: agentsInfo?.bytes,
    updatedAt: agentsInfo?.updatedAt,
    note: "全局规则与 Root Trigger Matrix",
  });

  const memoryFiles = await listMarkdown(path.join(roots.opencodeDir, "memory"), 1);
  for (const file of memoryFiles) {
    sources.push({
      id: `l0:memory:${relative(path.join(roots.opencodeDir, "memory"), file.path)}`,
      layer: "L0",
      label: `memory/${relative(path.join(roots.opencodeDir, "memory"), file.path)}`,
      path: file.path,
      scope: "global",
      authority: "authoritative",
      state: "ready",
      files: 1,
      bytes: file.bytes,
      updatedAt: file.updatedAt,
    });
  }
  if (memoryFiles.length === 0) {
    sources.push({
      id: "l0:memory",
      layer: "L0",
      label: "memory/",
      path: path.join(roots.opencodeDir, "memory"),
      scope: "global",
      authority: "authoritative",
      state: "missing",
      files: 0,
    });
  }

  const openchamberSettings = await readJson(
    path.join(roots.openchamberDir, "settings.json"),
  );
  const l1Enabled =
    openchamberSettings && typeof openchamberSettings === "object" &&
    typeof (openchamberSettings as Record<string, unknown>).agentMemoryToolEnabled === "boolean"
      ? Boolean((openchamberSettings as Record<string, unknown>).agentMemoryToolEnabled)
      : undefined;
  const l1Info = await fileInfo(path.join(roots.openchamberDir, "memory.json"));
  const l1Content = l1Info ? await readJson(l1Info.path) : undefined;
  sources.push({
    id: "l1:global",
    layer: "L1",
    label: "OpenChamber 全局记忆",
    path: l1Info?.path ?? path.join(roots.openchamberDir, "memory.json"),
    scope: "global",
    authority: "tentative",
    state: l1Enabled === false ? "disabled" : sourceStateForFile(l1Info),
    files: l1Info ? 1 : 0,
    entries: countEntries(l1Content),
    bytes: l1Info?.bytes,
    updatedAt: l1Info?.updatedAt,
    note: l1Enabled === false ? "agentMemoryToolEnabled = false" : "宿主注入的暂定记忆",
  });

  const projectMemoryRoot = path.join(roots.openchamberDir, "projects");
  let l1ProjectFiles = 0;
  let l1ProjectEntries = 0;
  try {
    const dirs = await readdir(projectMemoryRoot, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const info = await fileInfo(path.join(projectMemoryRoot, dir.name, "memory.json"));
      if (!info) continue;
      l1ProjectFiles += 1;
      const content = await readJson(info.path);
      l1ProjectEntries += countEntries(content) ?? 0;
    }
  } catch {
    // Missing projects directory is normal when the L1 switch is off.
  }
  sources.push({
    id: "l1:projects",
    layer: "L1",
    label: "OpenChamber 项目记忆",
    path: projectMemoryRoot,
    scope: "project",
    authority: "tentative",
    state: l1Enabled === false ? "disabled" : l1ProjectFiles > 0 ? "ready" : "missing",
    files: l1ProjectFiles,
    entries: l1ProjectEntries,
    note: l1Enabled === false ? "agentMemoryToolEnabled = false" : "按项目隔离",
  });

  if (projectDir) {
    const projectAgents = await fileInfo(path.join(projectDir, "AGENTS.md"));
    const projectOpencodeAgents = await fileInfo(
      path.join(projectDir, ".opencode", "AGENTS.md"),
    );
    const projectMemoryFiles = await listMarkdown(path.join(projectDir, ".memory"), 1);
    const files = [
      ...(projectAgents ? [projectAgents] : []),
      ...(projectOpencodeAgents ? [projectOpencodeAgents] : []),
      ...projectMemoryFiles,
    ];
    sources.push({
      id: "l2:project",
      layer: "L2",
      label: "项目记忆与规则",
      path: path.join(projectDir, ".memory"),
      scope: "project",
      authority: "authoritative",
      state: files.length > 0 ? "ready" : "missing",
      files: files.length,
      bytes: sum(files.map((file) => file.bytes)),
      updatedAt: files.map((file) => file.updatedAt).sort().at(-1),
      note: `${path.basename(projectDir)} · 仅当前实例`,
    });
  } else {
    sources.push({
      id: "l2:project",
      layer: "L2",
      label: "项目记忆与规则",
      scope: "unknown",
      authority: "unknown",
      state: "unknown",
      note: "当前进程没有项目目录",
    });
  }

  const pendingFiles = await listMarkdown(
    path.join(roots.opencodeDir, "memory", "PENDING"),
    1,
  );
  sources.push({
    id: "l3:pending",
    layer: "L3",
    label: "PENDING 待确认",
    path: path.join(roots.opencodeDir, "memory", "PENDING"),
    scope: "global",
    authority: "tentative",
    state: pendingFiles.length > 0 ? "ready" : "missing",
    files: pendingFiles.length,
    bytes: sum(pendingFiles.map((file) => file.bytes)),
  });

  if (projectDir) {
    const contextFiles = await listMarkdown(path.join(projectDir, ".context"), 1);
    sources.push({
      id: "l3:context",
      layer: "L3",
      label: "项目临时上下文",
      path: path.join(projectDir, ".context"),
      scope: "project",
      authority: "tentative",
      state: contextFiles.length > 0 ? "ready" : "missing",
      files: contextFiles.length,
      bytes: sum(contextFiles.map((file) => file.bytes)),
    });
  }

  const [items, queue, shadow, hooks, reviews, drafts] = await Promise.all([
    options.store.listItems(),
    options.store.listQueue(),
    options.store.listShadow(),
    options.store.listHooks(),
    options.store.listReviews(),
    options.store.listSkillDrafts(),
  ]);

  sources.push({
    id: "openmem:store",
    layer: "OpenMem",
    label: "OpenMem 插件数据",
    path: options.store.dataDir,
    scope: "mixed",
    authority: "tentative",
    state: "ready",
    files: 6,
    entries: items.length + queue.length + shadow.length,
    note: "独立暂定来源；不覆盖 L0/L2",
  });

  const logicFiles = await listMarkdown(roots.logicChainDir, 2);
  sources.push({
    id: "logic:chain",
    layer: "LogicChain",
    label: "逻辑链图",
    path: roots.logicChainDir,
    scope: "mixed",
    authority: "derived",
    state: logicFiles.length > 0 ? "ready" : "missing",
    files: logicFiles.length,
    bytes: sum(logicFiles.map((file) => file.bytes)),
    note: "派生视图，不作为独立权威",
  });

  const latestBackup = await latestBackupDir(roots.backupRoot);
  const backupChecks = latestBackup
    ? {
        l0: Boolean(await fileInfo(path.join(latestBackup, "global-entry", "AGENTS.md"))),
        l1: Boolean(await fileInfo(path.join(latestBackup, "openchamber-memory", "global.json"))),
        openmem: Boolean(
          await fileInfo(path.join(latestBackup, "global-memory", "autopilot", "items.jsonl")),
        ),
        project: await pathExists(path.join(latestBackup, "project-memory")),
        logic: await pathExists(path.join(latestBackup, "logic-chain")),
      }
    : undefined;
  sources.push({
    id: "backup:latest",
    layer: "Backup",
    label: "最新备份",
    path: latestBackup,
    scope: "mixed",
    authority: "derived",
    state: latestBackup
      ? backupChecks && Object.values(backupChecks).every(Boolean)
        ? "ready"
        : "partial"
      : "missing",
    note: latestBackup ? path.basename(latestBackup) : "未找到 backup-* 目录",
  });

  const layerSources = (layer: GraphLayer): GraphSource[] =>
    sources.filter((source) => source.layer === layer);
  const architectureNodes = [
    layerNode("architecture", "L0", layerSources("L0")),
    layerNode("architecture", "L1", layerSources("L1")),
    layerNode("architecture", "L2", layerSources("L2")),
    layerNode("architecture", "L3", layerSources("L3")),
    layerNode("architecture", "OpenMem", layerSources("OpenMem")),
    layerNode("architecture", "LogicChain", layerSources("LogicChain")),
    layerNode("architecture", "Backup", layerSources("Backup")),
  ];
  const architectureEdges = [
    edge("layer:L0", "layer:L2", "precedence", "项目规则补充"),
    edge("layer:L2", "layer:L1", "precedence", "冲突时项目规则优先"),
    edge("layer:L0", "layer:L1", "authority", "最高权威"),
    edge("layer:OpenMem", "layer:L1", "tentative", "暂定来源，不可覆盖"),
    edge("layer:LogicChain", "layer:L1", "derived", "派生视图"),
    edge("layer:Backup", "layer:L0", "snapshot", "快照"),
  ];

  const inventoryNodes: GraphNode[] = [
    ...items.map((item) => inventoryNode(item, "item")),
    ...queue.map((item) => inventoryNode(item, "queue")),
    ...shadow.map((record) => shadowNode(record)),
  ].slice(0, 500);
  const groups = buildGroups(
    [...items.filter((item) => item.status !== "archived"), ...queue].slice(0, 500),
  );

  const agentsText = agentsInfo ? await readText(agentsInfo.path) : undefined;
  const routes = agentsText ? parseTriggerMatrix(agentsText) : [];
  const routingNodes: GraphNode[] = [
    { id: "route:start", view: "routing", kind: "step", title: "会话开始" },
    { id: "route:agents", view: "routing", kind: "source", title: "AGENTS.md" },
    { id: "route:matrix", view: "routing", kind: "step", title: "Root Trigger Matrix" },
  ];
  const routingEdges = [
    edge("route:start", "route:agents", "reads", "启动读取"),
    edge("route:agents", "route:matrix", "contains", "触发矩阵"),
  ];
  const seenTargets = new Set<string>();
  routes.forEach((route, index) => {
    const signalID = `route:signal:${index}`;
    const targetID = `route:target:${sha16(route.target)}`;
    routingNodes.push(
      { id: signalID, view: "routing", kind: "trigger", title: route.signal },
    );
    if (!seenTargets.has(targetID)) {
      routingNodes.push(
        { id: targetID, view: "routing", kind: "target", title: route.target },
      );
      seenTargets.add(targetID);
    }
    routingEdges.push(
      edge("route:matrix", signalID, "matches", "命中"),
      edge(signalID, targetID, "reads", "读取"),
    );
  });

  const hookCounts = countBy(hooks.map((hook) => hook.status));
  const automationNodes: GraphNode[] = [
    automationNode("capture", "捕获", { hooks: hooks.length, pending: hookCounts.pending ?? 0 }),
    automationNode("classify", "分类", { queue: queue.length }),
    automationNode("dedupe", "去重", { shadow: shadow.length }),
    automationNode("route", "路由", { auto: items.filter((item) => item.status === "auto").length }),
    automationNode("queue", "审批队列", { entries: queue.length }),
    automationNode("review", "会话复盘", { reviews: reviews.length }),
    automationNode("apply", "批准与应用", { promoted: items.filter((item) => item.status === "promoted").length }),
    automationNode("audit", "审计与健康", { skills: drafts.length }),
    {
      id: "promotion:pending",
      view: "automation",
      kind: "promotion",
      title: "PENDING 候选",
      status: "manual",
      meta: { target: "L0 / L2" },
    },
    {
      id: "promotion:confirm",
      view: "automation",
      kind: "promotion",
      title: "用户确认",
      status: "manual",
      meta: { required: true },
    },
    {
      id: "promotion:target",
      view: "automation",
      kind: "promotion",
      title: "L0 / L2 规则",
      status: "manual",
    },
  ];
  const automationEdges = [
    edge("auto:capture", "auto:classify", "step", "候选"),
    edge("auto:classify", "auto:dedupe", "step", "分类结果"),
    edge("auto:dedupe", "auto:route", "step", "新候选"),
    edge("auto:route", "auto:queue", "branch", "需审批"),
    edge("auto:route", "auto:review", "branch", "复盘"),
    edge("auto:queue", "auto:apply", "step", "批准"),
    edge("auto:apply", "auto:audit", "step", "写入"),
    edge("promotion:pending", "promotion:confirm", "confirmation", "规则变更"),
    edge("promotion:confirm", "promotion:target", "promotion", "确认后晋升"),
  ];

  const rollbackText = await readText(
    path.join(roots.opencodeDir, "scripts", "rollback-memory.sh"),
  );
  const restore = {
    l0: true,
    l1: Boolean(rollbackText?.includes("restore_openchamber_memory")),
    project: Boolean(rollbackText?.includes("restore_project_memory")),
    openmem: Boolean(rollbackText?.match(/restore_openmem|OPENMEM_DATA_DIR/)),
    logic: Boolean(rollbackText?.match(/restore_logic_chain|逻辑链图/)),
  };
  const backupDomains: GraphNode[] = [
    backupNode("l0", "L0 规则", backupChecks?.l0, restore.l0),
    backupNode("l1", "OpenChamber L1", backupChecks?.l1, restore.l1),
    backupNode("openmem", "OpenMem 数据", backupChecks?.openmem, restore.openmem),
    backupNode("project", "项目记忆", backupChecks?.project, restore.project),
    backupNode("logic", "逻辑链图", backupChecks?.logic, restore.logic),
  ];
  const backupNodes: GraphNode[] = [
    {
      id: "backup:latest",
      view: "backup",
      kind: "snapshot",
      title: latestBackup ? path.basename(latestBackup) : "未找到备份",
      status: latestBackup ? "ready" : "missing",
      meta: {
        path: latestBackup ?? "",
        covered: backupChecks
          ? Object.values(backupChecks).filter(Boolean).length
          : 0,
      },
    },
    ...backupDomains,
  ];
  const backupEdges = backupDomains.map((node) =>
    edge("backup:latest", node.id, "snapshot", "备份覆盖"),
  );

  const architectureSources = sources.filter((source) => source.layer !== "Backup");
  const data: MemoryGraphData = {
    generatedAt: new Date().toISOString(),
    project: projectDir
      ? { label: path.basename(projectDir), key: sha16(projectDir) }
      : undefined,
    sources,
    groups,
    views: {
      architecture: {
        nodes: architectureNodes,
        edges: architectureEdges,
        summary: {
          sources: architectureSources.length,
          authoritative: architectureSources.filter(
            (source) => source.authority === "authoritative",
          ).length,
          l0: layerSources("L0").length,
          l1: layerSources("L1").length,
          l2: layerSources("L2").length,
          l3: layerSources("L3").length,
        },
      },
      inventory: {
        nodes: inventoryNodes,
        edges: [],
        summary: {
          total: items.length + queue.length + shadow.length,
          shown: inventoryNodes.length,
          truncated: inventoryNodes.length >= 500,
        },
      },
      routing: {
        nodes: routingNodes,
        edges: routingEdges,
        summary: {
          routes: routes.length,
          source: agentsInfo ? "ready" : "missing",
          matrix: routes.length > 0 ? "ready" : "unknown",
        },
      },
      automation: {
        nodes: automationNodes,
        edges: automationEdges,
        summary: {
          hooks: hooks.length,
          pending: hookCounts.pending ?? 0,
          queue: queue.length,
          shadow: shadow.length,
          reviews: reviews.length,
        },
      },
      backup: {
        nodes: backupNodes,
        edges: backupEdges,
        summary: {
          latest: latestBackup ? path.basename(latestBackup) : "missing",
          covered: backupChecks
            ? Object.values(backupChecks).filter(Boolean).length
            : 0,
          domains: 5,
          restoreOpenmem: restore.openmem,
          restoreLogic: restore.logic,
        },
      },
    },
  };
  return data;
}

function inventoryNode(
  item: Item | QueueItem,
  kind: "item" | "queue",
): GraphNode {
  return {
    id: `inv:${item.id}`,
    view: "inventory",
    kind: item.kind,
    title: item.title,
    scope: item.scope,
    status: kind === "queue" ? "queue" : item.status,
    sourceId: "openmem:store",
    meta: {
      id: item.id,
      priority: item.priority ?? 0,
      projectKey: item.projectKey ?? "",
      updatedAt: item.updatedAt,
      seenCount: item.seenCount ?? 1,
    },
  };
}

function buildGroups(entries: Array<Item | QueueItem>): GraphGroup[] {
  if (entries.length < 2) return [];
  const parent = new Map<string, string>(entries.map((entry) => [entry.id, entry.id]));
  const groupRelation = new Map<string, RelationKind>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    while (parent.get(id) !== root) {
      const next = parent.get(id) ?? root;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const relationRank = (relation: RelationKind): number =>
    relation === "conflict"
      ? 0
      : relation === "classification-mismatch"
        ? 1
        : relation === "exact"
          ? 2
          : relation === "covered"
            ? 3
            : 9;
  for (let left = 0; left < entries.length; left++) {
    for (let right = left + 1; right < entries.length; right++) {
      if (!sameScopeAndProject(entries[left], entries[right])) continue;
      const relation = classifyRelation(
        { text: entries[left].text, kind: entries[left].kind },
        { text: entries[right].text, kind: entries[right].kind },
      );
      if (
        relation.relation !== "exact" &&
        relation.relation !== "covered" &&
        relation.relation !== "classification-mismatch" &&
        relation.relation !== "conflict"
      ) {
        continue;
      }
      const leftRoot = find(entries[left].id);
      const rightRoot = find(entries[right].id);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
      const root = find(leftRoot);
      const candidates: RelationKind[] = [relation.relation];
      const previous = groupRelation.get(root);
      if (previous) candidates.push(previous);
      const other = groupRelation.get(rightRoot);
      if (other) candidates.push(other);
      candidates.sort((a, b) => relationRank(a) - relationRank(b));
      groupRelation.set(root, candidates[0]);
      if (rightRoot !== root) groupRelation.delete(rightRoot);
    }
  }
  const grouped = new Map<string, Array<Item | QueueItem>>();
  for (const entry of entries) {
    const root = find(entry.id);
    const list = grouped.get(root) ?? [];
    list.push(entry);
    grouped.set(root, list);
  }
  return [...grouped.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([root, list]) => {
      const relation = groupRelation.get(root) ?? "exact";
      const nodeIds = list.map((entry) => `inv:${entry.id}`);
      return {
        id: `group:${sha16(nodeIds.join("|"))}`,
        relation: relation as GraphGroup["relation"],
        title: list[0].title,
        nodeIds,
      };
    })
    .sort(
      (left, right) =>
        relationRank(left.relation) - relationRank(right.relation) ||
        right.nodeIds.length - left.nodeIds.length,
    )
    .slice(0, 50);
}

function shadowNode(record: ShadowRecord): GraphNode {
  return {
    id: `inv:${record.id}`,
    view: "inventory",
    kind: record.kind,
    title: record.title,
    scope: record.scope,
    status: record.falsePositive ? "false_positive" : "shadow",
    sourceId: "openmem:store",
    meta: {
      id: record.id,
      priority: record.priority,
      projectKey: record.projectKey ?? "",
      createdAt: record.createdAt,
    },
  };
}

function automationNode(
  id: string,
  title: string,
  meta: Record<string, number>,
): GraphNode {
  return { id: `auto:${id}`, view: "automation", kind: "step", title, meta };
}

function backupNode(
  id: string,
  title: string,
  backedUp: boolean | undefined,
  restore: boolean,
): GraphNode {
  const state =
    backedUp === undefined ? "unknown" : backedUp ? "ready" : "missing";
  return {
    id: `backup:${id}`,
    view: "backup",
    kind: "domain",
    title,
    status: state,
    meta: {
      backup: backedUp === undefined ? "unknown" : backedUp ? "yes" : "no",
      restore: restore ? "automatic" : "missing",
    },
  };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

async function latestBackupDir(root: string): Promise<string | undefined> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("backup-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return dirs[0] ? path.join(root, dirs[0]) : undefined;
  } catch {
    return undefined;
  }
}

function parseTriggerMatrix(markdown: string): Array<{ signal: string; target: string }> {
  const lines = markdown.split("\n");
  const routes: Array<{ signal: string; target: string }> = [];
  let inMatrix = false;
  for (const line of lines) {
    if (/^##\s+Root Trigger Matrix/i.test(line)) {
      inMatrix = true;
      continue;
    }
    if (inMatrix && /^##\s+/.test(line)) {
      inMatrix = false;
      continue;
    }
    if (!inMatrix || !line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 2) continue;
    if (/^:?-{2,}:?$/.test(cells[0])) continue;
    if (/task signal/i.test(cells[0])) continue;
    routes.push({
      signal: cleanMarkdownCell(cells[0]),
      target: cleanMarkdownCell(cells[1]),
    });
    if (routes.length >= 50) break;
  }
  return routes;
}

function cleanMarkdownCell(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function headingsOf(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
    .slice(0, 50);
}

export async function readGraphSource(
  options: BuildGraphOptions,
  id: string,
): Promise<GraphSourceDetail | undefined> {
  const graph = await buildMemoryGraph(options);
  const source = graph.sources.find((entry) => entry.id === id);
  if (!source?.path) return undefined;
  try {
    const info = await stat(source.path);
    if (info.isDirectory()) {
      const files = await listMarkdown(source.path, 1);
      return {
        id: source.id,
        label: source.label,
        path: source.path,
        state: source.state,
        headings: [],
        excerpt: "",
        truncated: false,
        files: files.map((file) => ({ name: file.name, bytes: file.bytes })),
      };
    }
    if (!info.isFile()) return undefined;
    const text = await readText(source.path, MAX_SOURCE_BYTES);
    if (text === undefined) return undefined;
    return {
      id: source.id,
      label: source.label,
      path: source.path,
      state: source.state,
      headings: headingsOf(text),
      excerpt: text.slice(0, 4000),
      truncated: text.length >= 4000,
    };
  } catch {
    return undefined;
  }
}
