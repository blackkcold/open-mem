import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../src/store.js";
import { applyRetention, previewRetention } from "../src/retention.js";
import type { Item } from "../src/types.js";
import { runConsolidation } from "../src/consolidate.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const now = Date.parse("2026-11-04T12:00:00Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-retention-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}
async function history(dir: string, type = "recovery", count = 25) {
  await mkdir(path.join(dir, type), { recursive: true });
  for (let i = 0; i < count; i++) await writeFile(path.join(dir, type, `${type}_${i}.json`), JSON.stringify({ id: `${type}_${i}`, at: daysAgo(120 + i), before: [], after: [], queue: {}, item: {} }));
}

describe("90-day retention with explicit preview", () => {
  it("does not delete cold session state when its archive ages past the history window", async () => {
    const { dir, store } = await fixture();
    try {
      await mkdir(path.join(dir, "session-archive"));
      for (let i = 0; i < 25; i++) {
        const file = store.sessionArchivePath(`old-${i}`);
        await writeFile(file, JSON.stringify({ id: path.basename(file, ".json"), sessionID: `old-${i}`, createdAt: daysAgo(120 + i), state: { lastScannedMessageID: `cursor-${i}` } }));
      }
      const preview = await previewRetention(store, now);
      expect(preview.deleteFiles).toEqual([]);
      await applyRetention(store, preview.id, true, now);
      expect((await store.readSession("old-24"))?.lastScannedMessageID).toBe("cursor-24");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("invalidates a preview when time alone changes the selected row deletions", async () => {
    const { dir, store } = await fixture();
    try {
      const rows: Item[] = Array.from({ length: 21 }, (_, i) => ({ id: `old-${i}`, title: "历史", text: "历史内容", scope: "global", kind: "fact", status: "archived", source: {}, createdAt: daysAgo(89), updatedAt: daysAgo(89 - i) }));
      await store.replaceItems(rows);
      const preview = await previewRetention(store, now);
      expect(preview.pruneItems).toBe(0);
      await expect(applyRetention(store, preview.id, true, now + 2 * 86_400_000)).rejects.toThrow("预览");
      expect(await store.listItems()).toHaveLength(21);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("protects a maintenance backup referenced by a retained curator", async () => {
    const { dir, store } = await fixture();
    try {
      await history(dir, "maintenance");
      for (let i = 0; i < 25; i++) await writeFile(path.join(dir, "maintenance", `maintenance_${i}.items.bak`), "snapshot");
      await mkdir(path.join(dir, "curator"));
      await writeFile(path.join(dir, "curator", "curator_recent.json"), JSON.stringify({ id: "curator_recent", createdAt: daysAgo(1), maintenanceID: "maintenance_24" }));
      const preview = await previewRetention(store, now);
      expect(preview.deleteFiles).not.toContain("maintenance/maintenance_24.json");
      expect(preview.deleteFiles).not.toContain("maintenance/maintenance_24.items.bak");
      expect(preview.deleteFiles).toHaveLength(8);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("replays an interrupted cleanup after the first actual file deletion", async () => {
    const { dir, store } = await fixture();
    try {
      await history(dir);
      await store.writeState({ sessions: { old: { lastRunAt: daysAgo(91), lastScannedMessageID: "m1" } } });
      const script = `import fs from 'node:fs/promises';
        const {Store}=await import('./src/store.ts');
        const {previewRetention,applyRetention}=await import('./src/retention.ts');
        const store=new Store(process.argv[1]);const now=Number(process.argv[2]);
        const preview=await previewRetention(store,now);const unlink=fs.unlink;
        fs.unlink=async(file)=>{const value=await unlink(file);if(String(file).includes('/recovery/')) process.exit(74);return value;};
        await applyRetention(store,preview.id,true,now);`;
      await expect(promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir, String(now)], { cwd: process.cwd() })).rejects.toMatchObject({ code: 74 });
      const recovered = new Store(dir);
      await recovered.init();
      expect(await readdir(path.join(dir, "recovery"))).toHaveLength(20);
      expect((await recovered.readState()).sessions.old).toBeUndefined();
      expect((await recovered.readSession("old"))?.lastScannedMessageID).toBe("m1");
      expect((await recovered.listChangelog()).filter((entry) => entry.action === "retention")).toHaveLength(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("previews without writes, keeps at least 20, and requires confirmation", async () => {
    const { dir, store } = await fixture();
    try {
      await history(dir);
      const original = await readFile(store.statePath, "utf8");
      const before = await readdir(path.join(dir, "recovery"));
      const preview = await previewRetention(store, now);
      expect(preview.deleteFiles).toHaveLength(5);
      expect(await readdir(path.join(dir, "recovery"))).toEqual(before);
      expect(await readFile(store.statePath, "utf8")).toBe(original);
      await expect(applyRetention(store, preview.id, false, now)).rejects.toThrow("确认");
      await applyRetention(store, preview.id, true, now);
      expect(await readdir(path.join(dir, "recovery"))).toHaveLength(20);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("protects 90-day records, in-progress records and unknown/corrupt history", async () => {
    const { dir, store } = await fixture();
    try {
      await history(dir);
      await writeFile(path.join(dir, "recovery", "recovery_24.json"), JSON.stringify({ id: "recovery_24", at: daysAgo(200), restoring: true }));
      await writeFile(path.join(dir, "recovery", "recovery_boundary.json"), JSON.stringify({ id: "recovery_boundary", at: daysAgo(90) }));
      await writeFile(path.join(dir, "recovery", "recovery_unknown.json"), "{broken");
      const preview = await previewRetention(store, now);
      expect(preview.deleteFiles).not.toContain("recovery/recovery_24.json");
      expect(preview.deleteFiles).not.toContain("recovery/recovery_boundary.json");
      expect(preview.deleteFiles).not.toContain("recovery/recovery_unknown.json");
      expect(preview.protectedCount).toBeGreaterThan(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("archives only inactive sessions and restores pinned context and cursors on resume", async () => {
    const { dir, store } = await fixture();
    try {
      await store.writeState({ sessions: {
        old: { lastRunAt: daysAgo(91), lastScannedMessageID: "m42", contextBlock: { version: 1, autoMemory: ["固定上下文"], autoRules: [], shadow: true } },
        recent: { lastRunAt: daysAgo(89) }, unknown: {}, running: { lastRunAt: daysAgo(200), reviewStatus: "running" },
      } });
      const preview = await previewRetention(store, now);
      expect(preview.archiveSessions).toEqual(["old"]);
      await applyRetention(store, preview.id, true, now);
      expect((await store.readState()).sessions.old).toBeUndefined();
      expect((await store.readSession("old"))?.lastScannedMessageID).toBe("m42");
      let calls = 0;
      await runConsolidation("old", { store, config: DEFAULT_CONFIG,
        decision: { async classify() { calls++; throw new Error("must not reclassify archived cursor"); } },
        readMessages: async () => [{ id: "m42", type: "user", text: "我喜欢回复先给结论" }] });
      expect(calls).toBe(0);
      await store.updateSession("old", { lastMessageID: "m43" });
      expect((await store.readState()).sessions.old.contextBlock?.autoMemory).toEqual(["固定上下文"]);
      expect((await store.readState()).sessions.old.lastScannedMessageID).toBe("m42");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects stale previews without deleting history", async () => {
    const { dir, store } = await fixture();
    try {
      await history(dir);
      const preview = await previewRetention(store, now);
      await store.updateSession("new", { lastMessageID: "m1" });
      await expect(applyRetention(store, preview.id, true, now)).rejects.toThrow("预览");
      expect(await readdir(path.join(dir, "recovery"))).toHaveLength(25);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("refuses symlink traversal without touching outside files", async () => {
    const { dir, store } = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "openmem-outside-"));
    try {
      await writeFile(path.join(outside, "keep.json"), "do not touch");
      await symlink(outside, path.join(dir, "recovery"), "dir");
      await expect(previewRetention(store, now)).rejects.toThrow(/symlink|符号链接/);
      expect(await readFile(path.join(outside, "keep.json"), "utf8")).toBe("do not touch");
    } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
  it("keeps active items and archived items referenced by protected recovery records", async () => {
    const { dir, store } = await fixture();
    try {
      const item = (id: string, index: number): Item => ({ id, title: id, text: "历史内容", scope: "global", kind: "fact", status: "archived", source: {}, createdAt: daysAgo(200), updatedAt: daysAgo(120 + index) });
      const rows = Array.from({ length: 25 }, (_, i) => item(`item_${i}`, i));
      await store.replaceItems([...rows, { ...item("active", 99), status: "auto" }]);
      await mkdir(path.join(dir, "recovery"));
      await writeFile(path.join(dir, "recovery", "recovery_keep.json"), JSON.stringify({ id: "recovery_keep", at: daysAgo(1), item: rows[24] }));
      const preview = await previewRetention(store, now);
      expect(preview.pruneItems).toBe(4);
      await applyRetention(store, preview.id, true, now);
      expect((await store.listItems()).find((item) => item.id === "active")?.status).toBe("auto");
      expect((await store.listItems()).some((item) => item.id === "item_24")).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
