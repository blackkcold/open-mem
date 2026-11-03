import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.js";
import { runConsolidation } from "../src/consolidate.js";
import type { DecisionProvider, JevResult, SessionMessage } from "../src/types.js";

const preferenceJev: JevResult = {
  kind: "preference",
  duplicate: 0,
  safeAuto: 0.96,
  risk: 0.1,
  confidence: 0.9,
  strictness: "preference",
  reasons: ["test"],
  source: "heuristic",
};

const riskyRuleJev: JevResult = {
  kind: "rule",
  duplicate: 0,
  safeAuto: 0.2,
  risk: 0.92,
  confidence: 0.5,
  strictness: "safety",
  reasons: ["test"],
  source: "heuristic",
};

function provider(result: JevResult): DecisionProvider {
  return { async classify() { return result; } };
}

const messages: SessionMessage[] = [
  { id: "m1", type: "user", text: "我喜欢回复先给结论" },
  { id: "m2", type: "assistant", text: "好的，以后先给结论。" },
];

describe("runConsolidation", () => {
  it("auto-writes a low-risk preference when shadow is off", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(preferenceJev),
        config,
        readMessages: async () => messages,
      });
      expect(result.auto).toBe(1);
      expect(result.queued).toBe(0);
      expect(await store.readAutoMemory()).toContain("先给结论");
      expect(await store.listQueue()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queues a risky rule and never writes it automatically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(riskyRuleJev),
        config,
        readMessages: async () => [
          { id: "m1", type: "user", text: "不要用 nohup 启动 dev server" },
        ],
      });
      expect(result.queued).toBe(1);
      expect((await store.listQueue())[0].kind).toBe("rule");
      expect(await store.readAutoMemory()).not.toContain("nohup");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a shadow decision when shadow mode is on", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: true });
      const result = await runConsolidation("s1", {
        store,
        decision: provider(preferenceJev),
        config,
        readMessages: async () => messages,
      });
      expect(result.shadowed).toBe(1);
      expect((await store.listShadow()).length).toBe(1);
      expect(await store.listItems()).toEqual([]);
      expect(await store.readAutoMemory()).not.toContain("先给结论");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not process the same last message twice", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-consolidate-"));
    try {
      const store = new Store(dir);
      await store.init();
      const config = mergeConfig(DEFAULT_CONFIG, { shadow: false });
      const deps = {
        store,
        decision: provider(preferenceJev),
        config,
        readMessages: async () => messages,
      };
      await runConsolidation("s1", deps);
      const second = await runConsolidation("s1", deps);
      expect(second.processed).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
