import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DigestCache } from "../src/digest/cache.js";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { ReviewInputBuilder } from "../src/review/input.js";
import type { SessionMessage } from "../src/types.js";

function user(id: string, text: string): SessionMessage {
  return { id, role: "user", type: "user", text };
}

function withTool(id: string, tool: string, state: Record<string, unknown>): SessionMessage {
  return {
    id,
    role: "assistant",
    type: "assistant",
    text: "",
    parts: [{ type: "tool", tool, state }],
  };
}

async function withBuilder<T>(
  configPatch: Parameters<typeof mergeConfig>[0],
  fn: (builder: ReviewInputBuilder) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-input-"));
  try {
    const store = new Store(dir);
    await store.init();
    const cache = new DigestCache(store, { maxEntries: 50 });
    await cache.load();
    const config = mergeConfig(configPatch);
    return await fn(new ReviewInputBuilder({ config, digestCache: cache }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ReviewInputBuilder", () => {
  it("keeps the newest messages inside the character budget", async () => {
    await withBuilder(
      { review: { maxInputChars: 200, maxUserCharsPerMessage: 100 } },
      async (builder) => {
        const messages = Array.from({ length: 6 }, (_, index) =>
          user(`m${index}`, `${index}`.repeat(80)),
        );
        const input = builder.build("ses_1", messages);
        expect(input.chars).toBeLessThanOrEqual(200);
        expect(input.truncated).toBe(true);
        expect(input.items.at(-1)?.id).toBe("m5");
        expect(input.items.some((item) => item.id === "m0")).toBe(false);
      },
    );
  });

  it("includes deterministic tool digests and their raw size", async () => {
    await withBuilder({}, async (builder) => {
      const messages = [
        user("m1", "跑一下测试看看哪里挂了"),
        withTool("m2", "bash", {
          status: "error",
          input: { command: "npm test" },
          metadata: { exit: 1 },
          output: "FAIL src/a.test.ts",
        }),
      ];
      const input = builder.build("ses_1", messages);
      const tool = input.items.find((item) => item.role === "tool");
      expect(tool?.text).toContain("npm test");
      expect(tool?.ok).toBe(false);
      expect(input.rawToolChars).toBeGreaterThan(0);
      expect(input.sources["m2"].tools[0].text).toContain("npm test");
    });
  });

  it("drops tool digests entirely in user-only mode", async () => {
    await withBuilder({ review: { transcript: "user" } }, async (builder) => {
      const input = builder.build("ses_1", [
        user("m1", "检查一下构建失败的原因"),
        withTool("m2", "bash", { status: "completed", input: { command: "ls" }, output: "a" }),
      ]);
      expect(input.items.every((item) => item.role === "user")).toBe(true);
      expect(input.toolCount).toBe(0);
    });
  });

  it("redacts credentials before they reach the model", async () => {
    await withBuilder({}, async (builder) => {
      const input = builder.build("ses_1", [
        user("m1", "数据库密码 = hunter2hunter2，记住这个连接方式"),
      ]);
      expect(input.items[0].text).not.toContain("hunter2hunter2");
      expect(input.items[0].text).toContain("[redacted]");
    });
  });

  it("produces a stable hash for the same window", async () => {
    await withBuilder({}, async (builder) => {
      const messages = [user("m1", "以后回复都用中文"), user("m2", "另外记得用 pnpm")];
      const first = builder.build("ses_1", messages);
      const second = builder.build("ses_1", messages);
      expect(first.hash).toBe(second.hash);
      const third = builder.build("ses_1", [
        ...messages,
        user("m3", "还有别的偏好吗？一起记下来"),
      ]);
      expect(third.hash).not.toBe(first.hash);
    });
  });

  it("uses the last message as the next cursor even when it is assistant prose", async () => {
    await withBuilder({}, async (builder) => {
      const input = builder.build("ses_1", [
        user("m1", "记住这个偏好：用 pnpm"),
        { id: "m2", role: "assistant", type: "assistant", text: "好的" },
      ]);
      expect(input.toMessageID).toBe("m2");
      expect(input.items.every((item) => item.role === "user")).toBe(true);
    });
  });

  it("excludes synthetic and keep-alive messages", async () => {
    await withBuilder({}, async (builder) => {
      const keepAlive =
        "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK";
      const input = builder.build("ses_1", [
        user("m1", "记住：以后回复先给结论"),
        { id: "m2", role: "user", type: "synthetic", text: keepAlive },
        user("m3", keepAlive),
      ]);
      expect(input.items.filter((item) => item.role === "user").map((item) => item.id)).toEqual([
        "m1",
      ]);
    });
  });
});
