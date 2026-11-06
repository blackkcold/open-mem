import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { runCurator, undoCurator } from "../src/memory/curator.js";
import type { Item } from "../src/types.js";

const now = Date.parse("2026-11-04T00:00:00.000Z");

function item(overrides: Partial<Item>): Item {
  const at = new Date(now).toISOString();
  return {
    id: "item_test",
    title: "test",
    text: "test",
    kind: "fact",
    scope: "global",
    status: "auto",
    source: { sessionID: "s1", messageID: "m1", role: "user" },
    createdAt: at,
    updatedAt: at,
    seenCount: 1,
    lastSeenAt: at,
    sources: [{ sessionID: "s1", messageID: "m1", role: "user" }],
    ...overrides,
  };
}

describe("zero-model curator", () => {
  it("refuses undo after a later edit without overwriting that edit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-curator-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item({ id: "a", expiresAt: new Date(now - 1).toISOString() }));
      const result = await runCurator(store, mergeConfig({}), { now, force: true });
      await store.updateItem("a", { text: "之后手动编辑的内容" });
      await expect(undoCurator(store, result.id ?? "")).rejects.toThrow("修改");
      expect((await store.listItems())[0].text).toBe("之后手动编辑的内容");
      expect((await store.listItems())[0].status).toBe("archived");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not merge project memories lacking project identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-curator-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item({ id: "a", scope: "project", text: "本地使用 pnpm" }));
      await store.appendItem(item({ id: "b", scope: "project", text: "本地使用 pnpm" }));
      expect((await runCurator(store, mergeConfig({}), { now, force: true })).merged).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("preserves an item appended after the curator reads its snapshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-curator-"));
    try {
      const store = new Store(dir);
      const other = new Store(dir);
      await store.init();
      await store.appendItem(item({ id: "expired", expiresAt: new Date(now - 1000).toISOString() }));
      const originalList = store.listItems.bind(store);
      let firstRead = true;
      vi.spyOn(store, "listItems").mockImplementation(async () => {
        const result = await originalList();
        if (firstRead) {
          firstRead = false;
          await other.appendItem(item({ id: "new" }));
        }
        return result;
      });
      await runCurator(store, mergeConfig({}), { now, force: true });
      expect((await other.listItems()).map((entry) => entry.id)).toContain("new");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("expires only auto, non-rule, non-manual items", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-curator-"));
    try {
      const store = new Store(dir);
      await store.init();
      const past = new Date(now - 1000).toISOString();
      const future = new Date(now + 1000).toISOString();
      await store.appendItem(item({ id: "expired", expiresAt: past }));
      await store.appendItem(
        item({ id: "promoted", status: "promoted", expiresAt: past }),
      );
      await store.appendItem(
        item({ id: "rule", kind: "rule", expiresAt: past }),
      );
      await store.appendItem(
        item({ id: "manual", expiresAt: past, manual: true }),
      );
      await store.appendItem(item({ id: "future", expiresAt: future }));

      const result = await runCurator(store, mergeConfig({}), {
        now,
        force: true,
      });
      expect(result.due).toBe(true);
      expect(result.expired).toBe(1);
      const items = await store.listItems();
      expect(items.find((entry) => entry.id === "expired")?.status).toBe(
        "archived",
      );
      expect(items.find((entry) => entry.id === "promoted")?.status).toBe(
        "promoted",
      );
      expect(items.find((entry) => entry.id === "rule")?.status).toBe("auto");
      expect(items.find((entry) => entry.id === "manual")?.status).toBe("auto");
      expect(items.find((entry) => entry.id === "future")?.status).toBe("auto");
      expect(result.journalPath).toBeTruthy();
      expect(
        JSON.parse(await readFile(result.journalPath ?? "", "utf8")).before,
      ).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("dedupes within a scope/project and isolates projects", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-curator-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(
        item({ id: "g1", text: "回复先给结论", scope: "global" }),
      );
      await store.appendItem(
        item({ id: "g2", text: "回复先给结论", scope: "global" }),
      );
      await store.appendItem(
        item({
          id: "a1",
          text: "回复先给结论",
          scope: "project",
          projectKey: "A",
        }),
      );
      await store.appendItem(
        item({
          id: "b1",
          text: "回复先给结论",
          scope: "project",
          projectKey: "B",
        }),
      );

      const result = await runCurator(store, mergeConfig({}), {
        now,
        force: true,
      });
      expect(result.merged).toBe(1);
      const items = await store.listItems();
      expect(items.filter((entry) => entry.status === "auto")).toHaveLength(3);
      expect(items.find((entry) => entry.id === "g2")?.status).toBe("archived");
      expect(items.find((entry) => entry.id === "a1")?.status).toBe("auto");
      expect(items.find((entry) => entry.id === "b1")?.status).toBe("auto");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not merge a changed version or opposite negation in similar text", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-curator-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(
        item({
          id: "a",
          text: "启动 dev server 时不要使用 nohup，因为退出终端后进程可能被回收；如果需要保持后台运行，应该先确认日志目录可写，再使用受控的后台任务并在关闭终端后检查端口是否仍然监听。",
        }),
      );
      await store.appendItem(
        item({
          id: "b",
          text: "启动 dev server 时使用 nohup，因为退出终端后进程可能被回收；如果需要保持后台运行，应该先确认日志目录可写，再使用受控的后台任务并在关闭终端后检查端口是否仍然监听。",
        }),
      );
      await store.appendItem(
        item({
          id: "c",
          text: "部署脚本要求 Node 版本是 2.4.1，并且使用 pnpm 安装依赖后运行构建，然后执行完整测试并记录构建身份，最后上传产物到临时目录等待人工核对。",
        }),
      );
      await store.appendItem(
        item({
          id: "d",
          text: "部署脚本要求 Node 版本是 2.4.2，并且使用 pnpm 安装依赖后运行构建，然后执行完整测试并记录构建身份，最后上传产物到临时目录等待人工核对。",
        }),
      );
      const result = await runCurator(store, mergeConfig({}), {
        now,
        force: true,
      });
      expect(result.merged).toBe(0);
      const items = await store.listItems();
      expect(items.filter((entry) => entry.status === "auto")).toHaveLength(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects the 24h gate and is idempotent when forced", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-curator-"));
    try {
      const store = new Store(dir);
      await store.init();
      const first = await runCurator(store, mergeConfig({}), {
        now,
        force: true,
      });
      expect(first.due).toBe(true);
      const gated = await runCurator(store, mergeConfig({}), {
        now: now + 60 * 60 * 1000,
      });
      expect(gated.due).toBe(false);
      const forced = await runCurator(store, mergeConfig({}), {
        now: now + 2 * 60 * 60 * 1000,
        force: true,
      });
      expect(forced.due).toBe(true);
      expect(forced.expired).toBe(0);
      expect(forced.merged).toBe(0);
      expect(forced.id).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("undoes a curator run", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-curator-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item({ id: "a", text: "回复先给结论，再给细节" }));
      await store.appendItem(item({ id: "b", text: "回复先给结论，再给细节" }));
      const result = await runCurator(store, mergeConfig({}), {
        now,
        force: true,
      });
      expect(result.merged).toBe(1);
      expect(
        (await store.listItems()).find((entry) => entry.id === "b")?.status,
      ).toBe("archived");
      expect(await undoCurator(store, result.id ?? "")).toBe(2);
      const items = await store.listItems();
      expect(items.find((entry) => entry.id === "a")?.status).toBe("auto");
      expect(items.find((entry) => entry.id === "b")?.status).toBe("auto");
      expect(await store.readAutoMemory()).toContain("回复先给结论");
      await expect(undoCurator(store, result.id ?? "")).rejects.toThrow("撤销");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
