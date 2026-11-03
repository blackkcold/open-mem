import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { computeHealth } from "../src/health.js";
import type { Item } from "../src/types.js";

const now = new Date().toISOString();

function item(id: string, title: string, text: string): Item {
  return {
    id,
    title,
    text,
    kind: "fact",
    scope: "global",
    status: "auto",
    source: { role: "user" },
    createdAt: now,
    updatedAt: now,
  };
}

describe("health score", () => {
  it("starts at 100 on an empty store", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-health-"));
    try {
      const store = new Store(dir);
      await store.init();
      const health = await computeHealth(store, DEFAULT_CONFIG);
      expect(health.score).toBe(100);
      expect(health.grade).toBe("good");
      expect(health.details.items).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("penalizes duplicates, conflicts, and decision fallbacks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-health-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item("a", "[F] same", "同样的记忆内容"));
      await store.appendItem(item("b", "[F] same", "同样的记忆内容"));
      await store.appendItem(item("c", "[F] same", "完全不同的结论"));
      await store.appendUsage({
        at: now,
        kind: "decision",
        provider: "ollama-cloud",
        model: "clef:27b-cloud",
        latencyMs: 10,
        ok: false,
        error: "timeout",
      });

      const health = await computeHealth(store, DEFAULT_CONFIG);
      expect(health.details.items).toBe(3);
      expect(health.details.duplicateRate).toBeGreaterThan(0);
      expect(health.details.conflictCount).toBeGreaterThanOrEqual(1);
      expect(health.details.decisionCalls).toBe(1);
      expect(health.breakdown.decisionFallback).toBe(1);
      expect(health.score).toBeLessThan(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
