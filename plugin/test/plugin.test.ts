import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setupPlugin, type PluginContext } from "../src/plugin.js";
import { Store } from "../src/store.js";
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
}

async function* eventStream(): AsyncGenerator<{ type: string; sessionID?: string; [key: string]: unknown }> {
  yield { type: "session.created", sessionID: "s1" };
  yield { type: "session.idle", sessionID: "s1" };
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function createMockContext(messages: SessionMessage[]): { ctx: PluginContext; state: MockState } {
  const state: MockState = {
    entries: [],
    prompts: [],
    commands: [],
    contextCalls: 0,
    disposed: 0,
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

describe("plugin setup with mock OpenCode context", () => {
  it("registers tool/commands, injects context, and routes session.idle to the queue", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-plugin-"));
    try {
      const messages: SessionMessage[] = [
        { id: "m1", type: "user", text: "不要用 nohup 启动 dev server" },
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
      ]);

      await waitFor(async () => ((await store.listQueue()).length > 0 ? true : undefined));
      const queue = await store.listQueue();
      expect(queue.length).toBe(1);
      expect(queue[0].kind).toBe("rule");
      expect(queue[0].reason).toMatch(/high risk|Jev|decision/);
      expect(state.contextCalls).toBeGreaterThan(0);
      expect(state.entries.some((entry) => entry.key === "plugin.memory-autopilot")).toBe(true);

      await waitFor(async () => (state.tool ? true : undefined));
      const tool = state.tool as MockTool;
      const status = await tool.execute({ action: "status" }, { sessionID: "s1" });
      expect(status.content).toContain("queue");
      const review = await tool.execute({ action: "review" }, { sessionID: "s1" });
      expect(review.content).toContain("nohup");
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
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
