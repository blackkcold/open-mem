import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GRAPH_VIEWS,
  filterInventory,
  graphViewLink,
  groupSources,
  isMemoryGraphView,
  stateTone,
} from "../../console/src/pages/memory-graph";
import type { GraphNode, GraphSource } from "../../console/src/types";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const nodes: GraphNode[] = [
  {
    id: "inv:1",
    view: "inventory",
    kind: "rule",
    title: "回复先给结论",
    scope: "global",
    status: "queue",
    meta: { id: "q1", priority: 80 },
  },
  {
    id: "inv:2",
    view: "inventory",
    kind: "fact",
    title: "Swift build",
    scope: "project",
    status: "auto",
    meta: { id: "i2", priority: 30 },
  },
];

const sources: GraphSource[] = [
  {
    id: "l0:agents",
    layer: "L0",
    label: "AGENTS.md",
    scope: "global",
    authority: "authoritative",
    state: "ready",
  },
  {
    id: "openmem:store",
    layer: "OpenMem",
    label: "OpenMem",
    scope: "mixed",
    authority: "tentative",
    state: "ready",
  },
];

describe("memory graph console model", () => {
  it("exposes five views plus the similarity subview", () => {
    expect(GRAPH_VIEWS.map((view) => view.id)).toEqual([
      "architecture",
      "inventory",
      "routing",
      "automation",
      "backup",
      "similarity",
    ]);
    expect(isMemoryGraphView("backup")).toBe(true);
    expect(isMemoryGraphView("bogus")).toBe(false);
    expect(graphViewLink("routing")).toBe("#map/routing");
  });

  it("groups sources by layer and never treats unknown as ready", () => {
    const groups = groupSources(sources);
    expect(groups.map((group) => group.layer)).toEqual(["L0", "OpenMem"]);
    expect(stateTone("ready")).toBe("success");
    expect(stateTone("disabled")).toBe("warning");
    expect(stateTone("unreadable")).toBe("error");
    expect(stateTone("unknown")).toBe("info");
  });

  it("filters inventory by title, status, kind and scope", () => {
    expect(filterInventory(nodes, { query: "结论" })).toHaveLength(1);
    expect(filterInventory(nodes, { status: "auto" })).toHaveLength(1);
    expect(filterInventory(nodes, { kind: "rule" })).toHaveLength(1);
    expect(filterInventory(nodes, { scope: "project" })).toHaveLength(1);
    expect(filterInventory(nodes, { status: "auto", kind: "rule" })).toHaveLength(0);
    expect(filterInventory(nodes, { query: "q1" })).toHaveLength(1);
  });

  it("labels backup existence, integrity, freshness and restore separately", () => {
    const view = source("../../console/src/pages/MemoryGraph.tsx");
    expect(view).toContain("完整性");
    expect(view).toContain("新鲜度");
    expect(view).toContain("恢复能力");
    expect(view).toContain("未演练");
    expect(view).toContain("latestComplete");
    expect(view).toContain("manifest");
    expect(view).toContain("结构完整不等于可恢复");
    expect(view).toContain('aria-label="备份与恢复覆盖"');
    expect(view).toContain("domain.notes");
    expect(view).toContain("drillStatus");
    expect(view).toContain("coverage.unknown");
    expect(view).not.toContain("缺失 / 手动");
    expect(view).not.toContain("自动恢复");
  });
});
