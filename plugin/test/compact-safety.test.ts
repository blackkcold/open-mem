import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { runCompaction } from "../src/compact.js";
import type { Item } from "../src/types.js";

describe("compaction safety", () => {
  it("resumes an interrupted maintenance undo without requiring a second restore", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-compact-"));
    try {
      const store = new Store(dir);
      await store.init();
      const before: Item = { id: "a", title: "a", text: "自动记忆", kind: "fact", scope: "global", status: "auto", source: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01" };
      await store.appendItem(before);
      const id = await store.applyItemChanges([before], [{ ...before, status: "archived" }]);
      const file = path.join(dir, "maintenance", `${id}.json`);
      const journal: Record<string, unknown> = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...journal, undoing: true }));
      await store.replaceItems([before]);
      expect(await store.undoMaintenance(id)).toBe(1);
      await expect(store.undoMaintenance(id)).rejects.toThrow("已撤销");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("records an undoable maintenance journal before merging", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-compact-"));
    try {
      const store = new Store(dir);
      await store.init();
      for (const id of ["a", "b"]) await store.appendItem({
        id, title: id, text: "相同记忆", kind: "fact", scope: "global", status: "auto",
        source: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await runCompaction(store, mergeConfig({}));
      const history = (await store.listChangelog()).find((entry) => entry.action === "compact");
      expect(history?.journalID).toEqual(expect.any(String));
      expect(await store.undoMaintenance(String(history?.journalID))).toBe(2);
      expect((await store.listItems()).filter((entry) => entry.status === "archived")).toEqual([]);
      await expect(store.undoMaintenance(String(history?.journalID))).rejects.toThrow("已撤销");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not overwrite a concurrent edit to an item it would merge", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-compact-"));
    try {
      const store = new Store(dir);
      const other = new Store(dir);
      await store.init();
      const item = (id: string): Item => ({
        id, title: id, text: "相同记忆", kind: "fact", scope: "global", status: "auto",
        source: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await store.appendItem(item("a"));
      await store.appendItem(item("b"));
      const originalList = store.listItems.bind(store);
      let firstRead = true;
      vi.spyOn(store, "listItems").mockImplementation(async () => {
        const result = await originalList();
        if (firstRead) {
          firstRead = false;
          await other.updateItem("b", { text: "用户修改后的记忆" });
        }
        return result;
      });
      await expect(runCompaction(store, mergeConfig({}))).rejects.toThrow("item changed during maintenance");
      expect((await other.listItems()).find((entry) => entry.id === "b")?.text).toBe("用户修改后的记忆");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("keeps items appended while compaction is preparing its replacement", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-compact-"));
    try {
      const store = new Store(dir);
      const other = new Store(dir);
      await store.init();
      const item = (id: string, text: string): Item => ({
        id, title: id, text, kind: "fact", scope: "global", status: "auto",
        source: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await store.appendItem(item("a", "相同记忆"));
      await store.appendItem(item("b", "相同记忆"));
      const originalList = store.listItems.bind(store);
      let firstRead = true;
      vi.spyOn(store, "listItems").mockImplementation(async () => {
        const result = await originalList();
        if (firstRead) {
          firstRead = false;
          await other.appendItem(item("new", "新记忆"));
        }
        return result;
      });
      await runCompaction(store, mergeConfig({}));
      expect((await other.listItems()).map((entry) => entry.id)).toContain("new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not merge two memories whose port values differ", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-compact-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = (id: string, text: string): Item => ({
        id, title: id, text, kind: "fact", scope: "global", status: "auto",
        source: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await store.appendItem(item("a", "本地 dev server 端口是 5198"));
      await store.appendItem(item("b", "本地 dev server 端口是 5199"));
      const result = await runCompaction(store, mergeConfig({}));
      expect(result.merged).toBe(0);
      expect(result.archived).toBe(0);
      expect((await store.listItems()).filter((entry) => entry.status === "auto")).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not merge opposite negation or a changed version in long text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-compact-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = (id: string, text: string): Item => ({
        id, title: id, text, kind: "fact", scope: "global", status: "auto",
        source: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await store.appendItem(item("a", "启动 dev server 时不要使用 nohup，因为退出终端后进程可能被回收；如果需要保持后台运行，应该先确认日志目录可写，再使用受控的后台任务并在关闭终端后检查端口是否仍然监听。"));
      await store.appendItem(item("b", "启动 dev server 时使用 nohup，因为退出终端后进程可能被回收；如果需要保持后台运行，应该先确认日志目录可写，再使用受控的后台任务并在关闭终端后检查端口是否仍然监听。"));
      await store.appendItem(item("c", "部署脚本要求 Node 版本是 2.4.1，并且使用 pnpm 安装依赖后运行构建，然后执行完整测试并记录构建身份，最后上传产物到临时目录等待人工核对。"));
      await store.appendItem(item("d", "部署脚本要求 Node 版本是 2.4.2，并且使用 pnpm 安装依赖后运行构建，然后执行完整测试并记录构建身份，最后上传产物到临时目录等待人工核对。"));
      const result = await runCompaction(store, mergeConfig({}));
      expect(result.merged).toBe(0);
      expect(result.archived).toBe(0);
      expect((await store.listItems()).filter((entry) => entry.status === "auto")).toHaveLength(4);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("still merges exact duplicates with the same kind", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-compact-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = (id: string, text: string): Item => ({
        id, title: id, text, kind: "fact", scope: "global", status: "auto",
        source: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await store.appendItem(item("a", "本地 dev server 使用 5199 端口。"));
      await store.appendItem(item("b", "本地 dev server 使用 5199 端口"));
      const result = await runCompaction(store, mergeConfig({}));
      expect(result.merged).toBe(1);
      expect(result.archived).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("preserves project boundaries and user-approved items", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-compact-"));
    try {
      const store = new Store(dir);
      await store.init();
      const item = (id: string, overrides: Partial<Item>): Item => ({
        id, title: "test", text: "使用相同的项目设置", kind: "fact", scope: "project",
        status: "auto", projectKey: "A", source: {},
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      });
      await store.appendItem(item("a", {}));
      await store.appendItem(item("b", { projectKey: "B" }));
      await store.appendItem(item("manual", { manual: true }));
      await store.appendItem(item("promoted", { status: "promoted" }));
      await store.appendItem(item("rule1", { kind: "rule" }));
      await store.appendItem(item("rule2", { kind: "rule" }));
      await runCompaction(store, mergeConfig({}));
      const items = await store.listItems();
      expect(items.filter((entry) => entry.status === "archived")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
