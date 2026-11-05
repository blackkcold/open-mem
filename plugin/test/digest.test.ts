import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { digestMessageTools, digestToolPart } from "../src/digest/tool.js";
import { DigestCache } from "../src/digest/cache.js";
import { Store } from "../src/store.js";
import type { SessionMessage } from "../src/types.js";

function toolMessage(tool: string, state: Record<string, unknown>): SessionMessage {
  return {
    id: "m1",
    role: "assistant",
    type: "assistant",
    text: "",
    parts: [{ type: "tool", tool, state }],
  };
}

describe("tool digests", () => {
  it("summarizes a successful bash call", () => {
    const digest = digestToolPart({
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "npm test" },
        output: "line one\nline two\nall good",
      },
    });
    expect(digest?.ok).toBe(true);
    expect(digest?.summary).toContain("npm test");
    expect(digest?.summary).toContain("all good");
    expect(digest?.signals).toContain("status:completed");
  });

  it("marks a failed bash call and keeps the error line", () => {
    const digest = digestToolPart({
      tool: "bash",
      state: {
        status: "error",
        input: { command: "npm run build" },
        metadata: { exit: 1 },
        output: "TS2307: Cannot find module",
      },
    });
    expect(digest?.ok).toBe(false);
    expect(digest?.signals).toContain("exit:1");
    expect(digest?.summary).toContain("TS2307");
  });

  it("never copies read content into the summary", () => {
    const digest = digestToolPart({
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/Users/me/secret/project.ts" },
        output: "export const API_KEY = 'super-secret-value';",
      },
    });
    expect(digest?.summary).toContain("project.ts");
    expect(digest?.summary).not.toContain("super-secret-value");
  });

  it("redacts credentials before hashing and summarizing", () => {
    const secret = "sk-abcdefghijklmnop123456";
    const digest = digestToolPart({
      tool: "bash",
      state: {
        status: "completed",
        input: { command: `curl -H "Authorization: Bearer ${secret}" https://x.test` },
        output: `token=${secret}`,
      },
    });
    expect(digest?.summary).not.toContain(secret);
    expect(digest?.summary).toContain("[redacted]");
  });

  it("is stable for identical tool output", () => {
    const part = {
      tool: "grep",
      state: { status: "completed", input: { pattern: "TODO" }, output: "a.ts:1\nb.ts:2" },
    };
    expect(digestToolPart(part)?.id).toBe(digestToolPart(part)?.id);
  });

  it("returns one digest per tool part and skips text parts", () => {
    const message: SessionMessage = {
      id: "m2",
      role: "assistant",
      type: "assistant",
      text: "done",
      parts: [
        { type: "text", text: "done" },
        { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "a.ts" } } },
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" } } },
      ],
    };
    expect(digestMessageTools(message)).toHaveLength(2);
  });
});

describe("DigestCache", () => {
  it("merges disjoint flushes from sibling cache instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-digest-"));
    try {
      const store = new Store(dir);
      await store.init();
      const a = new DigestCache(store), b = new DigestCache(new Store(dir));
      await Promise.all([a.load(), b.load()]);
      a.set({ id: "a", tool: "bash", ok: true, summary: "a", signals: [], chars: 1 });
      b.set({ id: "b", tool: "bash", ok: true, summary: "b", signals: [], chars: 1 });
      await Promise.all([a.flush(), b.flush()]);
      const c = new DigestCache(new Store(dir));
      await c.load();
      expect(c.get("a")).toBeDefined();
      expect(c.get("b")).toBeDefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("persists and reloads content-addressed digests", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-digest-"));
    try {
      const store = new Store(dir);
      await store.init();
      const cache = new DigestCache(store, { maxEntries: 10 });
      await cache.load();
      const digest = digestToolPart({
        tool: "bash",
        state: { status: "completed", input: { command: "ls" }, output: "a\nb" },
      });
      expect(digest).toBeDefined();
      cache.set(digest!);
      await cache.flush();
      expect(cache.get(digest!.id)?.summary).toBe(digest!.summary);

      const reloaded = new DigestCache(store, { maxEntries: 10 });
      await reloaded.load();
      expect(reloaded.get(digest!.id)?.summary).toBe(digest!.summary);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("evicts the oldest entries beyond the cap", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-digest-"));
    try {
      const store = new Store(dir);
      await store.init();
      const cache = new DigestCache(store, { maxEntries: 2 });
      await cache.load();
      cache.set({ id: "a", tool: "bash", ok: true, summary: "a", signals: [], chars: 1 });
      cache.set({ id: "b", tool: "bash", ok: true, summary: "b", signals: [], chars: 1 });
      cache.set({ id: "c", tool: "bash", ok: true, summary: "c", signals: [], chars: 1 });
      expect(cache.get("a")).toBeUndefined();
      expect(cache.stats().entries).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
