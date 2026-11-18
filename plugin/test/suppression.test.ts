import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { applySuggestion } from "../src/apply.js";
import { deactivateItem } from "../src/changes.js";
import { itemContentVersion } from "../src/fingerprint.js";
import {
  clearSuppression,
  hookKeysFor,
  isSuppressed,
  reviewHookKey,
  suppressionTextHash,
  suppressSource,
  turnHookKey,
} from "../src/memory/suppression.js";
import type { Item, QueueItem, Suggestion } from "../src/types.js";

const now = new Date().toISOString();
const source = { sessionID: "s1", messageID: "m1", role: "user" as const };

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_s",
    title: "偏好",
    text: "回复先给结论",
    kind: "preference",
    scope: "global",
    status: "auto",
    source,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-suppression-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

describe("same-source suppression", () => {
  it("uses the existing turn and review hook key formats", () => {
    const hash = suppressionTextHash("回复 先给结论");
    expect(turnHookKey(source, "回复 先给结论")).toBe(`s1|m1|${hash}`);
    expect(reviewHookKey(source, "回复 先给结论")).toBe(`review|s1|m1|${hash}`);
    // Whitespace/punctuation normalization matches the capture lane.
    expect(suppressionTextHash("回复 先给结论")).toBe(suppressionTextHash("回复先给结论。"));
    expect(hookKeysFor(source, "x")).toHaveLength(2);
    expect(hookKeysFor({ sessionID: "s1" }, "x")).toEqual([]);
  });

  it("suppresses both lanes of the real source, not a review id", async () => {
    const { dir, store } = await fixture();
    try {
      const rows = await suppressSource(store, item(), "reverted");
      expect(rows).toHaveLength(2);
      const hash = suppressionTextHash("回复先给结论");
      expect(rows.map((row) => row.hookKey).sort()).toEqual(
        [`review|s1|m1|${hash}`, `s1|m1|${hash}`].sort(),
      );
      expect(await isSuppressed(store, turnHookKey(source, "回复先给结论") ?? "", hash)).toBe(true);
      expect(await isSuppressed(store, reviewHookKey(source, "回复先给结论") ?? "", hash)).toBe(true);
      // A different message (an explicit correction) is a different key.
      const later = { sessionID: "s1", messageID: "m2", role: "user" as const };
      expect(await isSuppressed(store, turnHookKey(later, "回复先给结论") ?? "", hash)).toBe(false);
      expect(await isSuppressed(store, reviewHookKey(later, "回复先给结论") ?? "", hash)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("covers every stored source and alias of the item", async () => {
    const { dir, store } = await fixture();
    try {
      const rows = await suppressSource(store, item({
        aliases: ["先给结论再展开"],
        sources: [source, { sessionID: "s2", messageID: "m9", role: "user" }],
      }), "deactivated");
      // two sources x two texts x two lanes
      expect(rows).toHaveLength(8);
      expect(new Set(rows.map((row) => row.hookKey)).size).toBe(8);
      const hash = suppressionTextHash("先给结论再展开");
      expect(await isSuppressed(store, reviewHookKey({ sessionID: "s2", messageID: "m9" }, "先给结论再展开") ?? "", hash)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not duplicate an existing key and expires with until", async () => {
    const { dir, store } = await fixture();
    try {
      const first = await suppressSource(store, item(), "reverted");
      const second = await suppressSource(store, item(), "reverted");
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(0);
      expect(await store.listSuppressions()).toHaveLength(2);
      const hash = suppressionTextHash("回复先给结论");
      const key = turnHookKey(source, "回复先给结论") ?? "";
      await store.writeSuppressions(
        (await store.listSuppressions()).map((row) => ({
          ...row,
          until: new Date(Date.now() - 1000).toISOString(),
        })),
      );
      expect(await isSuppressed(store, key, hash)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("clears only the rows owned by the restored item", async () => {
    const { dir, store } = await fixture();
    try {
      await suppressSource(store, item({ id: "item_one" }), "reverted");
      await suppressSource(store, item({ id: "item_two", text: "另一条偏好" }), "reverted");
      expect(await store.listSuppressions()).toHaveLength(4);
      const cleared = await clearSuppression(store, "item_one");
      expect(cleared).toBe(2);
      const rest = await store.listSuppressions();
      expect(rest).toHaveLength(2);
      expect(rest.every((row) => row.itemID === "item_two")).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("suppresses the original captured text after a rewrite is applied", async () => {
    const { dir, store } = await fixture();
    try {
      const original = "回复先给结论";
      const rewritten = "回复先给结论，再给细节";
      const candidate: QueueItem = {
        ...item({ id: "q_rewrite", text: original, status: "queue" }),
        reason: "test",
        decision: {
          kind: "preference",
          duplicate: 0,
          safeAuto: 0.9,
          risk: 0.1,
          confidence: 0.9,
          strictness: "preference",
          reasons: [],
          source: "heuristic",
          mergeAction: "create",
          conflict: 0,
        },
        suggestion: {
          id: "sug_rewrite",
          queueID: "q_rewrite",
          action: "create",
          proposedTitle: "偏好",
          proposedText: rewritten,
          preserved: [original],
          dropped: [],
          rationale: "test",
          confidence: 0.96,
          source: "composer",
          validation: { ok: true, errors: [], warnings: [] },
          createdAt: now,
        } satisfies Suggestion,
        suggestionState: "ready",
      };
      await store.upsertQueue(candidate);
      const applied = await applySuggestion(store, mergeConfig({}), "q_rewrite");
      expect(applied.ok).toBe(true);
      const written = (await store.listItems())[0];
      expect(written.text).toBe(rewritten);
      expect(written.aliases).toContain(original);

      await deactivateItem(store, written.id, {
        expectedVersion: itemContentVersion(written),
      });
      const hash = suppressionTextHash(original);
      expect(await isSuppressed(store, turnHookKey(source, original) ?? "", hash)).toBe(true);
      expect(await isSuppressed(store, reviewHookKey(source, original) ?? "", hash)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
