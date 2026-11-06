import { describe, expect, it } from "vitest";
import { projectMap } from "../src/map.js";
import type { Item, QueueItem, ShadowRecord } from "../src/types.js";

const now = new Date().toISOString();

function item(id: string, title: string, text: string, status: Item["status"] = "auto"): Item {
  return {
    id,
    title,
    text,
    kind: "rule",
    scope: "global",
    status,
    source: {},
    createdAt: now,
    updatedAt: now,
  };
}

function queueItem(id: string, title: string, text: string): QueueItem {
  return {
    ...item(id, title, text, "queue"),
    reason: "test",
    priority: 80,
  };
}

function shadow(id: string, title: string, text: string): ShadowRecord {
  return {
    id,
    candidate: text,
    title,
    kind: "fact",
    scope: "global",
    wouldWriteTo: "AUTO_MEMORY.md",
    wouldApply: 1,
    jev: {
      kind: "fact",
      duplicate: 0,
      safeAuto: 0.96,
      risk: 0.1,
      confidence: 0.9,
      strictness: "unknown",
      reasons: [],
      source: "heuristic",
    },
    priority: 30,
    source: {},
    createdAt: now,
  };
}

describe("projectMap", () => {
  it("returns coordinates in [0,1] and a duplicate edge", () => {
    const data = projectMap({
      items: [
        item("a", "[R] dev server 用 nohup", "启动 dev server 时使用 nohup"),
        item("b", "[R] dev server 用 nohup", "启动 dev server 时使用 nohup"),
      ],
      queue: [queueItem("q", "[R] nohup", "启动 dev server 时使用 nohup")],
      shadow: [shadow("s", "[F] swift build", "Swift 包用 swift build 构建")],
    });
    expect(data.nodes.length).toBe(4);
    for (const node of data.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(1);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(1);
    }
    expect(data.edges.some((edge) => edge.relation === "duplicate")).toBe(true);
    expect(data.nodes.map((node) => node.status)).toContain("queue");
    expect(data.nodes.map((node) => node.status)).toContain("shadow");
  });

  it("never exposes entry bodies on map nodes", () => {
    const itemText = "secret item body 111111";
    const queueText = "secret queue body 222222";
    const shadowText = "secret shadow body 333333";
    const data = projectMap({
      items: [item("a", "[R] visible title", itemText)],
      queue: [queueItem("q", "[R] queue title", queueText)],
      shadow: [shadow("s", "[F] shadow title", shadowText)],
    });
    const allowed = new Set(["id", "title", "kind", "scope", "status", "priority", "x", "y"]);
    for (const node of data.nodes) {
      expect(Object.keys(node).every((key) => allowed.has(key))).toBe(true);
      expect(node).not.toHaveProperty("text");
      expect(node).not.toHaveProperty("candidate");
      expect(JSON.stringify(node)).not.toContain("secret ");
    }
    const wire = JSON.stringify(data);
    expect(wire).not.toContain(itemText);
    expect(wire).not.toContain(queueText);
    expect(wire).not.toContain(shadowText);
  });

  it("handles a single node and empty input", () => {
    const single = projectMap({ items: [item("a", "x", "a single memory")], queue: [], shadow: [] });
    expect(single.nodes.length).toBe(1);
    expect(single.nodes[0].x).toBeGreaterThanOrEqual(0);
    expect(single.nodes[0].y).toBeGreaterThanOrEqual(0);

    const empty = projectMap({ items: [], queue: [], shadow: [] });
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
  });
});
