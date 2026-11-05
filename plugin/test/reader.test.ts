import { describe, expect, it } from "vitest";
import { SessionReader } from "../src/session/reader.js";

interface RawMessage {
  info: { id: string; role: "user" | "assistant"; time?: { created: number } };
  parts: Array<{ type: string; text?: string; tool?: string; state?: unknown }>;
}

function user(id: string, text: string, created = 1): RawMessage {
  return { info: { id, role: "user", time: { created } }, parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): RawMessage {
  return { info: { id, role: "assistant" }, parts: [{ type: "text", text }] };
}

function readerFor(source: { messages: RawMessage[] }) {
  return new SessionReader(async () => source.messages);
}

describe("SessionReader", () => {
  it("re-normalizes only the tail and new messages", async () => {
    const source = {
      messages: [user("m1", "端口是 47821"), assistant("m2", "收到"), user("m3", "记住用 pnpm")],
    };
    const reader = readerFor(source);
    const first = await reader.read("ses_1");
    expect(first).toHaveLength(3);
    expect(reader.stats().normalized).toBe(3);

    source.messages = [...source.messages, user("m4", "回复用中文")];
    const second = await reader.read("ses_1");
    expect(second).toHaveLength(4);
    // Previous tail (m3) plus the new message (m4) are the only fresh work.
    expect(reader.stats().normalized).toBe(5);
    expect(reader.stats().reused).toBeGreaterThanOrEqual(2);
  });

  it("rebuilds the cache when the session is truncated", async () => {
    const source = { messages: [user("m1", "a"), user("m2", "b"), user("m3", "c")] };
    const reader = readerFor(source);
    await reader.read("ses_1");
    const before = reader.stats().normalized;

    source.messages = [user("m3", "c"), user("m4", "d")];
    const next = await reader.read("ses_1");
    expect(next.map((message) => message.id)).toEqual(["m3", "m4"]);
    expect(reader.stats().normalized).toBeGreaterThan(before);
  });

  it("caps cached messages and returns the newest ones", async () => {
    const source = {
      messages: Array.from({ length: 12 }, (_, index) => user(`m${index}`, `line ${index}`)),
    };
    const reader = new SessionReader(async () => source.messages, { maxMessages: 5 });
    const messages = await reader.read("ses_1");
    expect(messages).toHaveLength(5);
    expect(messages.at(-1)?.id).toBe("m11");
  });

  it("returns a delta after a cursor and never loses tool state", async () => {
    const source = {
      messages: [
        user("m1", "跑一下测试"),
        {
          info: { id: "m2", role: "assistant" as const },
          parts: [
            {
              type: "tool",
              tool: "bash",
              state: { status: "completed", input: { command: "npm test" }, output: "ok" },
            },
          ],
        },
        user("m3", "继续"),
      ],
    };
    const reader = readerFor(source);
    const delta = await reader.delta("ses_1", "m1");
    expect(delta.map((message) => message.id)).toEqual(["m2", "m3"]);
    expect(delta[0].parts?.[0].tool).toBe("bash");
  });

  it("finds the last user message and its timestamp", async () => {
    const source = {
      messages: [user("m1", "a", 10), assistant("m2", "b"), user("m3", "c", 30)],
    };
    const reader = readerFor(source);
    expect(await reader.lastUser("ses_1")).toEqual({ id: "m3", time: 30 });
  });

  it("evicts the least recently used session", async () => {
    const source = { messages: [user("m1", "a")] };
    const reader = new SessionReader(async () => source.messages, { maxSessions: 2 });
    await reader.read("ses_1");
    await reader.read("ses_2");
    await reader.read("ses_3");
    expect(reader.stats().sessions).toBe(2);
  });
});
