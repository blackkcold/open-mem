import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupPlugin, type PluginContext } from "../src/plugin.js";
import { Store } from "../src/store.js";
import { sha16 } from "../src/util/text.js";
import type { SessionMessage } from "../src/types.js";

interface MockTool {
  name: string;
  execute(input: unknown, context: { sessionID?: string }): Promise<{ content: string }>;
}

interface MockCommand {
  name: string;
  execute(input: { sessionID: string }): Promise<void>;
}

interface MockState {
  entries: Array<{ sessionID: string; key: string; value: unknown }>;
  prompts: string[];
  tool?: MockTool;
  commands: MockCommand[];
  hook?: (event: { sessionID?: string; system?: Array<{ type: string; text: string }> }) => void | Promise<void>;
  contextCalls: number;
  disposed: number;
  opened: string[];
}

async function* eventStream(): AsyncGenerator<{ type: string; sessionID?: string; data?: unknown; [key: string]: unknown }> {
  // V2 delivers the payload under `data`; session.idle is ephemeral and not
  // delivered to ctx.event.subscribe, so turn completion arrives as
  // session.execution.succeeded.
  yield { type: "session.created", data: { sessionID: "s1" } };
  yield { type: "session.execution.succeeded", data: { sessionID: "s1" } };
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function createMockContext(messages: SessionMessage[]): { ctx: PluginContext; state: MockState } {
  const state: MockState = {
    entries: [],
    prompts: [],
    commands: [],
    contextCalls: 0,
    disposed: 0,
    opened: [],
  };
  const ctx: PluginContext = {
    location: { directory: "/tmp/openmem-plugin-test" },
    event: {
      subscribe() {
        return eventStream();
      },
    },
    session: {
      async context() {
        state.contextCalls += 1;
        return messages;
      },
      async prompt(input) {
        state.prompts.push(input.text);
        return {};
      },
      async hook(_name, callback) {
        state.hook = callback;
        return {
          async dispose() {
            state.disposed += 1;
          },
        };
      },
      instructions: {
        entry: {
          async put(input) {
            state.entries.push(input);
          },
        },
      },
    },
    tool: {
      async transform(callback) {
        callback({
          add(tool) {
            state.tool = tool as MockTool;
          },
        });
        return {
          async dispose() {
            state.disposed += 1;
          },
        };
      },
    },
    command: {
      async transform(callback) {
        callback({
          add(command) {
            state.commands.push(command as MockCommand);
          },
        });
        return {
          async dispose() {
            state.disposed += 1;
          },
        };
      },
    },
  };
  return { ctx, state };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeout = 3_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}

/** Plugin writes can outlive dispose by a tick; retry the removal. */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("plugin setup with mock OpenCode context", () => {
  it("lets the owning workspace process an event seen first by another workspace", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-plugin-"));
    const disposers: Array<() => Promise<void>> = [];
    try {
      const a = createMockContext([{ id: "m1", type: "user", text: "记住这个项目采用 pnpm 安装依赖" }]);
      const b = createMockContext([{ id: "m1", type: "user", text: "记住这个项目采用 pnpm 安装依赖" }]);
      a.ctx.location = { directory: "/workspace/A" };
      b.ctx.location = { directory: "/workspace/B" };
      const subscribe = async function* () {
        yield { id: "created", type: "session.created", location: { directory: "/workspace/B" }, data: { sessionID: "owner-session" } };
        yield { id: "finished", type: "session.execution.succeeded", location: { directory: "/workspace/B" }, data: { sessionID: "owner-session" } };
      };
      a.ctx.event = { subscribe };
      b.ctx.event = { subscribe };
      disposers.push(await setupPlugin(a.ctx, { dataDir: dir, console: false }));
      disposers.push(await setupPlugin(b.ctx, { dataDir: dir, console: false }));
      const store = new Store(dir);
      const hooks = await waitFor(async () => {
        const hooks = await store.listHooks();
        return hooks.length ? hooks : undefined;
      });
      expect(hooks[0].project).toBe("/workspace/B");
    } finally { for (const dispose of disposers) await dispose(); await removeDir(dir); }
  });
  it("reconnects after an event stream failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-plugin-"));
    let dispose: (() => Promise<void>) | undefined;
    try {
      const { ctx } = createMockContext([]);
      let subscriptions = 0;
      ctx.event = { subscribe: async function* () { subscriptions++; if (subscriptions === 1) throw new Error("synthetic stream failure"); yield { type: "session.created", data: { sessionID: "reconnected" } }; } };
      dispose = await setupPlugin(ctx, { dataDir: dir, console: false });
      await waitFor(async () => (await new Store(dir).readState()).sessions.reconnected);
      expect(subscriptions).toBeGreaterThan(1);
    } finally { await dispose?.(); await removeDir(dir); }
  });
  it("backfills parent metadata when the creation event omitted it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-plugin-"));
    let dispose: (() => Promise<void>) | undefined;
    try {
      const { ctx } = createMockContext([{ id: "m1", type: "user", text: "每次回复先给结论" }]);
      if (ctx.session) ctx.session.get = async () => ({ parentID: "parent" });
      dispose = await setupPlugin(ctx, { dataDir: dir, console: false });
      const store = new Store(dir);
      await waitFor(async () => (await store.readState()).sessions.s1?.parentSessionID);
      expect(await store.listHooks()).toEqual([]);
    } finally { await dispose?.(); await removeDir(dir); }
  });
  it("keeps agent tool approvals out of the user decision lane", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-plugin-"));
    let dispose: (() => Promise<void>) | undefined;
    try {
      const { ctx, state } = createMockContext([]);
      ctx.event = undefined;
      const store = new Store(dir);
      await store.init();
      dispose = await setupPlugin(ctx, { dataDir: dir, console: false });
      const at = new Date().toISOString();
      await store.upsertQueue({ id: "q_tool", title: "偏好", text: "回复先给结论", kind: "preference", scope: "global", status: "queue", source: {}, createdAt: at, updatedAt: at, reason: "test" });
      await state.tool?.execute({ action: "decide", id: "q_tool", decision: "approve" }, {});
      expect(await store.listQueue()).toHaveLength(1);
      expect(await store.listItems()).toEqual([]);
    } finally {
      await dispose?.();
      await removeDir(dir);
    }
  });
  it("scopes agent reads and writes to the calling project and session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-plugin-"));
    let dispose: (() => Promise<void>) | undefined;
    try {
      const { ctx, state } = createMockContext([]);
      ctx.location = { directory: "/workspace/A" };
      ctx.event = undefined;
      const store = new Store(dir);
      await store.init();
      const at = new Date().toISOString();
      const projectA = sha16("/workspace/A");
      const projectB = sha16("/workspace/B");
      await store.upsertQueue({
        id: "qa", title: "A专属标题", text: "A 项目使用 pnpm", kind: "preference",
        scope: "project", projectKey: projectA, status: "queue",
        source: { sessionID: "s1" }, createdAt: at, updatedAt: at, reason: "test",
      });
      await store.upsertQueue({
        id: "qb", title: "B专属标题", text: "B 项目使用 yarn", kind: "preference",
        scope: "project", projectKey: projectB, status: "queue",
        source: { sessionID: "s9" }, createdAt: at, updatedAt: at, reason: "test",
      });
      await store.upsertQueue({
        id: "qs", title: "S专属标题", text: "本会话的临时规则", kind: "preference",
        scope: "session", status: "queue",
        source: { sessionID: "s1" }, createdAt: at, updatedAt: at, reason: "test",
      });
      dispose = await setupPlugin(ctx, { dataDir: dir, console: false });
      const tool = state.tool;
      expect(tool).toBeDefined();

      const review = JSON.parse(
        (await tool?.execute({ action: "review" }, { sessionID: "s1" }))?.content ?? "[]",
      ) as Array<{ id: string }>;
      expect(review.map((entry) => entry.id).sort()).toEqual(["qa", "qs"]);

      const suggestForeign = await tool?.execute(
        { action: "suggest", id: "qb" },
        { sessionID: "s1" },
      );
      expect(suggestForeign?.content).toContain("不存在");
      expect((await store.listQueue()).find((entry) => entry.id === "qb")?.suggestion).toBeUndefined();

      const decideForeign = await tool?.execute(
        { action: "decide", id: "qb", decision: "deny" },
        { sessionID: "s1" },
      );
      expect(decideForeign?.content).toContain("不存在");
      expect((await store.listQueue()).map((entry) => entry.id).sort()).toEqual([
        "qa", "qb", "qs",
      ]);

      const status = JSON.parse(
        (await tool?.execute({ action: "status" }, { sessionID: "s1" }))?.content ?? "{}",
      ) as { queue: number };
      expect(status.queue).toBe(2);

      const audit = await tool?.execute({ action: "audit" }, { sessionID: "s1" });
      expect(audit?.content).not.toContain("B专属标题");
    } finally {
      await dispose?.();
      await removeDir(dir);
    }
  });

  it("reports console availability without leaking the long-lived token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-plugin-"));
    let dispose: (() => Promise<void>) | undefined;
    try {
      const { ctx, state } = createMockContext([]);
      ctx.event = undefined;
      dispose = await setupPlugin(ctx, {
        dataDir: dir,
        console: true,
        port: 0,
        token: "status-long-lived-token",
        shadow: false,
        openExternal: async (url) => {
          state.opened.push(url);
          return true;
        },
      });
      // Let the fire-and-forget curator finish before the temp dir is removed.
      await waitFor(async () => (await new Store(dir).readState()).lastCuratedAt);
      const status = await state.tool?.execute({ action: "status" }, {});
      const content = status?.content ?? "";
      expect(content).not.toContain("status-long-lived-token");
      expect(content).not.toContain("token=");
      expect(content).not.toContain("connect=");
      const body = JSON.parse(content) as {
        console: { available: boolean; url: string; connect: string };
      };
      expect(body.console.available).toBe(true);
      expect(body.console.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(body.console.connect).not.toContain("console_url");

      const link = await state.tool?.execute({ action: "console_url" }, {});
      expect(link?.content).toContain("/memory-console");
      expect(link?.content).not.toContain("connect=");
      expect(link?.content).not.toContain("status-long-lived-token");
      // A model tool call must not open the browser; only the user command does.
      expect(state.opened).toHaveLength(0);

      const consoleCommand = state.commands.find((command) => command.name === "memory-console");
      await consoleCommand?.execute({ sessionID: "s1" });
      expect(state.opened).toHaveLength(1);
      expect(state.opened[0]).toContain("connect=");
      expect(state.prompts.every((prompt) => !prompt.includes("connect="))).toBe(true);
    } finally {
      await dispose?.();
      await removeDir(dir);
    }
  });
  it("registers tool/commands, injects context, and routes session.idle to the queue", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-plugin-"));
    try {
      const messages: SessionMessage[] = [
        { id: "m1", type: "user", text: "回复必须使用 Markdown 格式" },
      ];
      const { ctx, state } = createMockContext(messages);
      const store = new Store(dir);
      const cleanup = await setupPlugin(ctx, {
        dataDir: dir,
        console: false,
        shadow: false,
      });

      expect(state.tool?.name).toBe("memory_autopilot");
      expect(state.commands.map((command) => command.name).sort()).toEqual([
        "memory-audit",
        "memory-console",
        "memory-review",
        "memory-review-session",
      ]);

      await waitFor(async () => ((await store.listQueue()).length > 0 ? true : undefined));
      const queue = await waitFor(async () => {
        const items = await store.listQueue();
        return items[0]?.suggestion ? items : undefined;
      });
      expect(queue.length).toBe(1);
      expect(queue[0].kind).toBe("rule");
      expect(queue[0].suggestionState).toBe("ready");
      expect(queue[0].reason).toMatch(/high risk|Jev|decision/);
      expect(state.contextCalls).toBeGreaterThan(0);
      expect(state.entries.some((entry) => entry.key === "plugin.memory-autopilot")).toBe(true);

      await waitFor(async () => (state.tool ? true : undefined));
      const tool = state.tool as MockTool;
      const status = await tool.execute({ action: "status" }, { sessionID: "s1" });
      expect(status.content).toContain("queue");
      const review = await tool.execute({ action: "review" }, { sessionID: "s1" });
      expect(review.content).toContain("Markdown");
      const audit = await tool.execute({ action: "audit" }, { sessionID: "s1" });
      expect(audit.content).toContain("findings");
      const consoleURL = await tool.execute({ action: "console_url" }, { sessionID: "s1" });
      expect(consoleURL.content).toContain("disabled");
      const learned = await tool.execute(
        {
          action: "learn_skill",
          title: "local-test",
          text: "Run a local test workflow.",
          scenario: "Run a local test workflow.",
          references: ["script/test.sh"],
        },
        { sessionID: "s1" },
      );
      expect(learned.content).toContain("path");
      expect((await store.listSkillDrafts()).length).toBe(1);

      const reviewCommand = state.commands.find((command) => command.name === "memory-review");
      await reviewCommand?.execute({ sessionID: "s1" });
      expect(state.prompts.length).toBeGreaterThan(0);

      await state.hook?.({ sessionID: "s2", system: [] });
      expect(state.entries.some((entry) => entry.sessionID === "s2")).toBe(true);

      await cleanup();
      expect(state.disposed).toBeGreaterThan(0);
    } finally {
      await removeDir(dir);
    }
  }, 10_000);
});
