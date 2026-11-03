import { describe, expect, it } from "vitest";
import {
  collectNeighbors,
  entriesFor,
  fingerprintText,
  isExactDuplicate,
  textSimilarity,
} from "../src/fingerprint.js";
import type { Item, QueueItem, ShadowRecord } from "../src/types.js";

const now = new Date().toISOString();

function item(id: string, text: string, kind: Item["kind"] = "preference"): Item {
  return {
    id,
    title: `[P] ${text.slice(0, 12)}`,
    text,
    kind,
    scope: "global",
    status: "auto",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
    seenCount: 1,
    lastSeenAt: now,
    sources: [{ role: "user" }],
  };
}

function queueItem(id: string, text: string): QueueItem {
  return {
    ...item(id, text),
    status: "queue",
    reason: "test",
  };
}

function shadow(id: string, text: string): ShadowRecord {
  return {
    id,
    candidate: text,
    title: `[P] ${text.slice(0, 12)}`,
    kind: "preference",
    scope: "global",
    wouldWriteTo: "AUTO_MEMORY.md",
    wouldApply: 1,
    priority: 20,
    source: { role: "user" },
    createdAt: now,
  };
}

describe("fingerprint", () => {
  it("is deterministic and detects exact/near duplicates", () => {
    const text = "启动 dev server 时使用 nohup";
    expect(fingerprintText(text)).toBe(fingerprintText(text));
    expect(isExactDuplicate(text, `${text}。`)).toBe(true);
    expect(textSimilarity(text, `${text}。`)).toBeGreaterThan(0.9);
    expect(isExactDuplicate(text, "本地 dev server 端口是 5199")).toBe(false);
  });

  it("ranks the closest neighbor and includes queue/shadow sources", () => {
    const entries = entriesFor(
      [item("i1", "回复先给结论，再给细节")],
      [queueItem("q1", "回复先给结论")],
      [shadow("s1", "项目文档默认用中文")],
    );
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["i1", "q1", "s1"]),
    );
    const neighbors = collectNeighbors("回复先给结论", entries, 3);
    expect(neighbors[0].id).toBe("q1");
    expect(neighbors.map((entry) => entry.id)).toContain("i1");
    expect(neighbors[0].similarity).toBeGreaterThan(0.35);
  });
});
