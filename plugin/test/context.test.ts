import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import {
  buildContext,
  refreshContext,
  renderContext,
  type PluginContext,
} from "../src/plugin.js";
import type { Item, QueueItem } from "../src/types.js";

function item(overrides: Partial<Item>): Item {
  const now = new Date().toISOString();
  return {
    id: "item_test",
    title: "test",
    text: "test",
    kind: "fact",
    scope: "global",
    status: "auto",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function queueItem(overrides: Partial<QueueItem>): QueueItem {
  return {
    ...item(overrides),
    id: "queue_test",
    status: "queue",
    reason: "test",
    suggestionState: undefined,
    ...overrides,
  };
}

describe("renderContext", () => {
  it("reserves room for global memory in a busy project", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-context-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item({ id: "global", text: "全局偏好", scope: "global" }));
      for (let i = 0; i < 12; i++) await store.appendItem(item({ id: `p${i}`, text: `项目记忆${i}`, scope: "project", projectKey: "A" }));
      const context = await buildContext(store, mergeConfig({}), "A");
      expect(context.autoMemory).toContain("全局偏好");
      expect(context.autoMemory).toHaveLength(10);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("keeps volatile counts out of the cached system prefix", () => {
    const text = renderContext({
      version: 1,
      autoMemory: ["本地 dev server 端口是 5199"],
      autoRules: ["回复先给结论"],
      shadow: true,
    });
    expect(text).not.toContain("Pending review");
    expect(text).not.toContain("Audit:");
    expect(text).toContain("Shadow mode: on");
    expect(text).toContain("action=status");
  });

  it("filters project memory by projectKey", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-context-"));
    try {
      const store = new Store(dir);
      await store.init();
      const base = "2026-01-01T00:00:00.000Z";
      await store.appendItem(item({ id: "g1", text: "global rule", kind: "rule", scope: "global", createdAt: base }));
      await store.appendItem(item({ id: "a1", text: "A rule", kind: "rule", scope: "project", projectKey: "A", createdAt: base }));
      await store.appendItem(item({ id: "b1", text: "B rule", kind: "rule", scope: "project", projectKey: "B", createdAt: base }));
      await store.appendItem(item({ id: "g2", text: "global fact", scope: "global", createdAt: base }));
      await store.appendItem(item({ id: "a2", text: "A fact", scope: "project", projectKey: "A", createdAt: base }));
      const config = mergeConfig({});
      const a = await buildContext(store, config, "A");
      expect(a.autoRules).toEqual(["global rule", "A rule"]);
      expect(a.autoMemory).toContain("global fact");
      expect(a.autoMemory).toContain("A fact");
      expect(a.autoMemory).not.toContain("B rule");
      const b = await buildContext(store, config, "B");
      expect(b.autoRules).toEqual(["global rule", "B rule"]);
      const none = await buildContext(store, config, undefined);
      expect(none.autoRules).toEqual(["global rule"]);
      expect(none.autoMemory).toEqual(["global fact"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pins context across 20 calls while the queue changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-context-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item({ id: "stable", text: "stable memory", scope: "global" }));
      const puts: Array<{ sessionID: string; key: string; value: unknown }> = [];
      const ctx: PluginContext = {
        session: {
          context: async () => [],
          instructions: {
            entry: {
              async put(input) {
                puts.push(input);
              },
            },
          },
        },
      };
      const config = mergeConfig({});
      for (let index = 0; index < 20; index += 1) {
        await store.writeQueue([
          queueItem({ id: `q${index}`, text: `queue ${index}`, title: `queue ${index}` }),
        ]);
        await refreshContext(ctx, store, config, "ses_pin", "A");
      }
      expect(puts).toHaveLength(1);
      const value = puts[0].value as Parameters<typeof renderContext>[0];
      expect(renderContext(value)).toContain("stable memory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes only when stable memory changes", () => {
    const base = {
      version: 1 as const,
      autoMemory: ["a"],
      autoRules: [],
      shadow: true,
    };
    const next = { ...base, autoMemory: ["a", "b"] };
    expect(renderContext(base)).not.toBe(renderContext(next));
    expect(renderContext(base)).toBe(renderContext({ ...base }));
  });
});
