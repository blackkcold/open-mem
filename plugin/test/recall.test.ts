import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import {
  RECALL_HEADER,
  recallMemory,
  renderRecallBlock,
  scoreRecall,
  tokenizeRecallQuery,
} from "../src/recall.js";
import type { Item } from "../src/types.js";

/**
 * P04 retrieval behavior: bounded, deterministic, local. Every test seeds a
 * throwaway Store; no model, network or real data is involved.
 */

const now = new Date().toISOString();
const source = { sessionID: "s1", messageID: "m1", role: "user" as const };

function item(text: string, overrides: Partial<Item> = {}): Item {
  return {
    id: "item_1",
    title: "t",
    text,
    kind: "fact",
    scope: "global",
    status: "auto",
    source,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-recall-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

describe("P04 recall features", () => {
  it("matches Chinese bigrams so 复盘失败 finds the failure memory", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([
        item("上次复盘失败的原因是缓存", { id: "item_fail" }),
        item("发布流程先跑测试", { id: "item_unrelated" }),
      ]);

      const result = await recallMemory(store, mergeConfig({}), "复盘失败");

      expect(result.hits.map((hit) => hit.id)).toEqual(["item_fail"]);
      expect(result.hits[0].reasons).toContain("cjk:盘失");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a single-character query as one feature instead of dropping it", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([
        item("端口是 5199", { id: "item_port" }),
        item("复盘失败的原因是缓存", { id: "item_other" }),
      ]);

      const tokens = tokenizeRecallQuery("端");
      expect(tokens.cjkBigrams).toEqual(["端"]);

      const result = await recallMemory(store, mergeConfig({}), "端");
      expect(result.hits.map((hit) => hit.id)).toEqual(["item_port"]);
      expect(result.hits[0].reasons).toContain("cjk:端");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never splits identifiers such as plugin.ts, /api/items or `npm run verify`", async () => {
    const { dir, store } = await fixture();
    try {
      const tokens = tokenizeRecallQuery(
        "改 plugin.ts 的 /api/items，再跑 `npm run verify`",
      );
      expect(tokens.identifiers).toEqual(
        expect.arrayContaining(["plugin.ts", "/api/items", "npm run verify"]),
      );
      expect(tokens.identifiers).not.toContain("plugin");
      expect(tokens.identifiers).not.toContain("ts");
      expect(tokens.words ?? []).not.toContain("plugin");
      expect(tokens.words ?? []).not.toContain("ts");

      await store.replaceItems([
        item("改 /api/items 后必须 npm run verify 和 plugin.ts 一起动", {
          id: "item_identifiers",
        }),
      ]);
      const result = await recallMemory(
        store,
        mergeConfig({}),
        "改 plugin.ts 的 /api/items，再跑 `npm run verify`",
      );
      expect(result.hits.map((hit) => hit.id)).toEqual(["item_identifiers"]);
      expect(result.hits[0].reasons).toEqual(
        expect.arrayContaining([
          "identifier:plugin.ts",
          "identifier:/api/items",
          "identifier:npm run verify",
        ]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a different number as numericConflict instead of a weak hit", async () => {
    const { dir, store } = await fixture();
    try {
      const tokens = tokenizeRecallQuery("端口是 5199");
      const conflict = scoreRecall(item("端口是 5198"), tokens);
      expect(conflict?.numericConflict).toBe(true);

      await store.replaceItems([
        item("端口是 5199", { id: "item_5199" }),
        item("端口是 5198", { id: "item_5198" }),
      ]);
      const result = await recallMemory(store, mergeConfig({}), "端口是 5199");
      expect(result.hits.map((hit) => hit.id)).toEqual(["item_5199"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not match the opposite negation parity", async () => {
    const { dir, store } = await fixture();
    try {
      const tokens = tokenizeRecallQuery("不要用 pnpm");
      const opposite = scoreRecall(item("项目必须用 pnpm 安装依赖"), tokens);
      expect(opposite?.negationMismatch).toBe(true);

      await store.replaceItems([
        item("不要用 pnpm，依赖统一走 yarn", { id: "item_negated" }),
        item("项目必须用 pnpm 安装依赖", { id: "item_opposite" }),
      ]);
      const result = await recallMemory(store, mergeConfig({}), "不要用 pnpm");
      expect(result.hits.map((hit) => hit.id)).toEqual(["item_negated"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sees global plus the current project only", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([
        item("复盘失败 global", { id: "g", scope: "global" }),
        item("复盘失败 p1", { id: "p1", scope: "project", projectKey: "P1" }),
        item("复盘失败 p2", { id: "p2", scope: "project", projectKey: "P2" }),
        item("复盘失败 session", { id: "s", scope: "session" }),
      ]);

      const current = await recallMemory(store, mergeConfig({}), "复盘失败", {
        projectKey: "P1",
      });
      expect(new Set(current.hits.map((hit) => hit.id))).toEqual(new Set(["g", "p1"]));

      const noProject = await recallMemory(store, mergeConfig({}), "复盘失败");
      expect(noProject.hits.map((hit) => hit.id)).toEqual(["g"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits a whole item that does not fit the token budget", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([
        item("端口是 5199", {
          id: "item_new",
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
        item("端口是 5200", {
          id: "item_old",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]);

      // One short hit renders at 54 tokens; two render at 66. A 60-token budget
      // therefore keeps the first item whole and never truncates the second.
      const tight = await recallMemory(store, mergeConfig({}), "端口", {
        tokenBudget: 60,
      });
      expect(tight.hits.map((hit) => hit.id)).toEqual(["item_new"]);
      expect(tight.hits).toHaveLength(1);
      expect(tight.tokens).toBeGreaterThan(0);
      expect(tight.degraded).toBeUndefined();

      const rendered = renderRecallBlock(tight.hits, 0);
      expect(rendered).toContain("端口是 5199");
      expect(rendered).not.toContain("端口是 5200");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes a long item whole when the budget is large enough", async () => {
    const { dir, store } = await fixture();
    try {
      const longText = `复盘失败${"原因".repeat(400)}`;
      await store.replaceItems([item(longText, { id: "item_long" })]);

      const tight = await recallMemory(store, mergeConfig({}), "复盘失败", {
        tokenBudget: 100,
      });
      expect(tight.hits).toHaveLength(0);
      expect(tight.degraded).toEqual({ reason: "budget" });

      const roomy = await recallMemory(store, mergeConfig({}), "复盘失败", {
        tokenBudget: 2_000,
      });
      expect(roomy.hits).toHaveLength(1);
      expect(roomy.hits[0].text).toBe(longText);
      expect(roomy.tokens).toBeLessThanOrEqual(2_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a degraded empty result when the store read fails", async () => {
    const { dir, store } = await fixture();
    const spy = vi
      .spyOn(Store.prototype, "listItems")
      .mockRejectedValueOnce(new Error("synthetic state read failure"));
    try {
      const result = await recallMemory(store, mergeConfig({}), "复盘失败");
      expect(result).toEqual({
        hits: [],
        tokens: 0,
        degraded: { reason: "store_error" },
      });
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses score only for ordering, never for wording", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([
        item("plugin.ts 是入口", { id: "item_id", updatedAt: "2026-01-01T00:00:00.000Z" }),
        item("复盘失败要记录原因", {
          id: "item_cjk",
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      ]);

      const byScore = await recallMemory(
        store,
        mergeConfig({}),
        "plugin.ts 复盘失败",
      );
      expect(byScore.hits.map((hit) => hit.id)).toEqual(["item_cjk", "item_id"]);
      expect(byScore.hits.map((hit) => hit.score)).toEqual([6, 4]);
      expect(byScore.hits.every((hit) => !("confidence" in hit))).toBe(true);
      expect(byScore.hits.every((hit) => !("probability" in hit))).toBe(true);

      const rendered = renderRecallBlock(byScore.hits, 0);
      expect(rendered).not.toContain("%");
      expect(rendered).toContain(RECALL_HEADER);

      // Equal scores fall back to newest update, then id: still ordering only.
      await store.replaceItems([
        item("复盘失败的原因甲", { id: "item_a", updatedAt: "2026-01-01T00:00:00.000Z" }),
        item("复盘失败的原因乙", { id: "item_b", updatedAt: "2026-01-02T00:00:00.000Z" }),
      ]);
      const tied = await recallMemory(store, mergeConfig({}), "复盘失败");
      expect(tied.hits.map((hit) => hit.id)).toEqual(["item_b", "item_a"]);
      expect(new Set(tied.hits.map((hit) => hit.score))).toEqual(new Set([6]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not treat an irrelevant date as a numeric conflict", async () => {
    const { dir, store } = await fixture();
    try {
      // A date in the memory is not a competing value when the query carries
      // no number at all.
      const plain = tokenizeRecallQuery("复盘失败的原因");
      expect(plain.numbers).toEqual([]);
      expect(
        scoreRecall(item("复盘失败的原因是缓存，记录于 2026-11-18"), plain)?.numericConflict,
      ).toBeUndefined();

      // A date is a structural identifier, not a numeric value, so it cannot
      // create a numeric conflict on either side.
      const dated = tokenizeRecallQuery("复盘失败 2026-11-18");
      expect(dated.identifiers).toContain("2026-11-18");
      expect(dated.numbers).toEqual([]);
      expect(
        scoreRecall(item("复盘失败的原因是缓存"), dated)?.numericConflict,
      ).toBeUndefined();

      await store.replaceItems([
        item("复盘失败的原因是缓存，记录于 2026-11-18", { id: "item_dated" }),
      ]);
      const result = await recallMemory(store, mergeConfig({}), "复盘失败的原因");
      expect(result.hits.map((hit) => hit.id)).toEqual(["item_dated"]);
      expect(result.hits[0].numericConflict).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches 禁止使用 pnpm in the same direction and rejects the opposite", async () => {
    const { dir, store } = await fixture();
    try {
      const tokens = tokenizeRecallQuery("禁止使用 pnpm");
      expect(tokens.negations).toBe(1);
      expect(
        scoreRecall(item("禁止使用 pnpm，依赖统一走内网镜像"), tokens)?.negationMismatch,
      ).toBeUndefined();
      expect(
        scoreRecall(item("项目必须用 pnpm 安装依赖"), tokens)?.negationMismatch,
      ).toBe(true);

      await store.replaceItems([
        item("禁止使用 pnpm，依赖统一走内网镜像", { id: "item_forbidden" }),
        item("项目必须用 pnpm 安装依赖", { id: "item_opposite" }),
      ]);
      const result = await recallMemory(store, mergeConfig({}), "禁止使用 pnpm");
      expect(result.hits.map((hit) => hit.id)).toEqual(["item_forbidden"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never inflates the score with repeated text, so a long item cannot outrank an exact hit", async () => {
    const { dir, store } = await fixture();
    try {
      const query = "复盘失败原因是缓存";
      const tokens = tokenizeRecallQuery(query);
      const exact = scoreRecall(item(query), tokens);
      const repeated = scoreRecall(item(query.repeat(50)), tokens);
      const long = scoreRecall(item(`复盘${"无关内容".repeat(500)}缓存`), tokens);

      // Repeating the same bigrams 50 times adds no score at all.
      expect(repeated?.score).toBe(exact?.score);
      expect(repeated?.score).toBe(16);
      // A long text keeps only the two query bigrams it actually contains.
      expect(long?.score).toBe(4);
      expect(long?.reasons).toEqual(["cjk:复盘", "cjk:缓存"]);

      await store.replaceItems([
        item(query, { id: "item_exact", updatedAt: "2026-01-01T00:00:00.000Z" }),
        item(`复盘${"无关内容".repeat(500)}缓存`, {
          id: "item_long",
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      ]);
      // The exact hit wins on score even though the long item is newer. The
      // budget is raised so only ordering, never truncation, decides this.
      const result = await recallMemory(store, mergeConfig({}), query, {
        tokenBudget: 4_000,
      });
      expect(result.hits.map((hit) => hit.id)).toEqual(["item_exact", "item_long"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns identical hits and reasons for repeated identical calls", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([
        item("复盘失败的原因是缓存", { id: "item_a" }),
        item("复盘失败的原因是网络", { id: "item_b" }),
      ]);
      const first = await recallMemory(store, mergeConfig({}), "复盘失败原因");
      const second = await recallMemory(store, mergeConfig({}), "复盘失败原因");
      expect(second).toEqual(first);
      expect(second.hits.map((hit) => hit.reasons)).toEqual(
        first.hits.map((hit) => hit.reasons),
      );
      expect(second.hits.map((hit) => hit.id)).toEqual(["item_a", "item_b"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
