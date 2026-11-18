import { describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { buildContext, refreshContext, renderContext, type PluginContext } from "../src/plugin.js";
import { applyContextRequest, applyOwnedContext, applyOwnedContextDetailed, CONTEXT_KEY } from "../src/plugin.js";
import { setupPlugin } from "../src/plugin.js";
import { deactivateItem, newChangeID, recordChange } from "../src/changes.js";
import { itemContentVersion } from "../src/fingerprint.js";
import type { Item } from "../src/types.js";

const now = new Date().toISOString();
const source = { sessionID: "s1", messageID: "m1", role: "user" as const };

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item_c",
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-context-version-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

async function seed(store: Store, value: Item) {
  const changeID = newChangeID();
  const written = { ...value, changeID };
  await store.transaction(async () => {
    await store.appendItem(written);
    return recordChange(store, {
      kind: "add", actor: "auto", itemID: written.id, item: written,
      source, origin: "turn", reason: "auto",
    });
  });
  return written;
}

function pluginContext(): { ctx: PluginContext; puts: Array<{ value: unknown }> } {
  const puts: Array<{ value: unknown }> = [];
  return {
    puts,
    ctx: {
      session: {
        context: async () => [],
        instructions: {
          entry: {
            async put(input) {
              puts.push(input);
            },
          },
        },
      },
    },
  };
}

describe("memory version invalidation", () => {
  it("keeps the prefix byte-identical for 20 requests when nothing changed", async () => {
    const { dir, store } = await fixture();
    try {
      await seed(store, item({ text: "稳定偏好" }));
      const { ctx, puts } = pluginContext();
      const config = mergeConfig({});
      for (let index = 0; index < 20; index += 1) {
        await refreshContext(ctx, store, config, "ses_stable", "A");
      }
      expect(puts).toHaveLength(1);
      expect(renderContext(puts[0].value as Parameters<typeof renderContext>[0])).toContain("稳定偏好");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("excludes a stopped item on the next request of an already existing session", async () => {
    const { dir, store } = await fixture();
    try {
      const written = await seed(store, item({ text: "要被停止的偏好" }));
      const { ctx, puts } = pluginContext();
      const config = mergeConfig({});
      await refreshContext(ctx, store, config, "ses_old", "A");
      expect(puts).toHaveLength(1);
      const pinned = await store.readSession("ses_old");
      expect(pinned?.contextVersion).toBe(await store.memoryVersion());

      const stop = await deactivateItem(store, written.id, {
        expectedVersion: itemContentVersion(written),
      });
      expect(stop.ok).toBe(true);

      await refreshContext(ctx, store, config, "ses_old", "A");
      expect(puts).toHaveLength(2);
      expect(renderContext(puts[1].value as Parameters<typeof renderContext>[0])).not.toContain("要被停止的偏好");
      expect(await store.readSession("ses_old")).toMatchObject({
        contextVersion: await store.memoryVersion(),
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("includes new memory on the next request instead of pinning it forever", async () => {
    const { dir, store } = await fixture();
    try {
      await seed(store, item({ id: "item_1", text: "第一条偏好" }));
      const { ctx, puts } = pluginContext();
      const config = mergeConfig({});
      await refreshContext(ctx, store, config, "ses_new", "A");
      await seed(store, item({ id: "item_2", text: "第二条偏好" }));
      await refreshContext(ctx, store, config, "ses_new", "A");
      expect(puts).toHaveLength(2);
      expect(renderContext(puts[1].value as Parameters<typeof renderContext>[0])).toContain("第二条偏好");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("changes the version when the clock crosses an expiry with no write", async () => {
    const { dir, store } = await fixture();
    try {
      const base = Date.parse("2026-06-01T00:00:00.000Z");
      await seed(store, item({
        id: "item_ttl",
        text: "端口是 5199",
        expiresAt: new Date(base + 60_000).toISOString(),
      }));
      const before = await store.memoryVersion(base);
      const file = await stat(store.itemsPath);
      const later = await store.memoryVersion(base + 120_000);
      const after = await stat(store.itemsPath);
      expect(file.mtimeMs).toBe(after.mtimeMs);
      expect(file.size).toBe(after.size);
      expect(later).not.toBe(before);
      const blockNow = await buildContext(store, mergeConfig({}), undefined, base);
      const blockLater = await buildContext(store, mergeConfig({}), undefined, base + 120_000);
      expect(blockNow.autoMemory).toContain("端口是 5199");
      expect(blockLater.autoMemory).not.toContain("端口是 5199");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("drops expired and invalidated rows from the injected block", async () => {
    const { dir, store } = await fixture();
    try {
      const base = Date.parse("2026-06-01T00:00:00.000Z");
      await store.replaceItems([
        item({ id: "item_ok", text: "有效偏好", createdAt: now }),
        item({
          id: "item_expired",
          text: "过期偏好",
          expiresAt: new Date(base - 1000).toISOString(),
        }),
        item({ id: "item_invalid", text: "失效偏好", invalidatedBy: "item_up", invalidatedAt: now }),
        item({ id: "item_stopped", text: "停用偏好", status: "archived" }),
      ]);
      const block = await buildContext(store, mergeConfig({}), undefined, base);
      expect(block.autoMemory).toEqual(["有效偏好"]);
      expect(renderContext(block)).not.toContain("过期偏好");
      expect(renderContext(block)).not.toContain("失效偏好");
      expect(renderContext(block)).not.toContain("停用偏好");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps the version stable across reads but reacts to an external write", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item({ id: "item_ext", text: "外部写入前" })]);
      const first = await store.memoryVersion();
      const second = await store.memoryVersion();
      expect(second).toBe(first);
      // Another Store instance / process writes items.jsonl.
      const other = new Store(dir);
      await other.replaceItems([item({ id: "item_ext", text: "外部写入后" })]);
      const third = await store.memoryVersion();
      expect(third).not.toBe(first);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

/**
 * Fake host: assembles `event.system` exactly like V2 does for an existing
 * session whose keyed entry was written earlier. The old pinned text is what
 * the host still carries because entry updates land at the next step boundary.
 */
describe("real context hook lifecycle", () => {
  const OPEN = `<context key="${CONTEXT_KEY}">`;
  const CLOSE = "</context>";

  function hostParts(ownedText: string): Array<{
    type: string;
    text: string;
    metadata?: Record<string, unknown>;
  }> {
    return [
      {
        type: "text",
        text: 'You are OpenCode.\n<context key="core/date">2026-11-11</context>',
        metadata: { experimental: { instructions: [{ key: "core/date", text: "2026-11-11" }] } },
      },
      {
        type: "text",
        text: `${OPEN}\n${ownedText}\n${CLOSE}`,
        metadata: { experimental: { instructions: [{ key: CONTEXT_KEY, text: ownedText }] } },
      },
      { type: "text", text: '<context key="other.plugin">其他插件的块</context>' },
    ];
  }

  function ownedTextOf(parts: Array<{ text: string }>): string {
    const part = parts.find((entry) => entry.text.includes(OPEN));
    if (!part) return "";
    const start = part.text.indexOf(OPEN) + OPEN.length;
    const end = part.text.indexOf(CLOSE, start);
    return part.text.slice(start, end);
  }

  it("drops a stopped item on the next request even when the host still carries the old block", async () => {
    const { dir, store } = await fixture();
    try {
      const written = await seed(store, item({ text: "要被停止的偏好" }));
      const config = mergeConfig({});
      const { ctx, puts } = pluginContext();
      const oldText = renderContext(await buildContext(store, config, undefined));

      const messages = [{ id: "m1", text: "用户原话" }];
      const first = { sessionID: "ses_old", system: hostParts(oldText), messages };
      await applyContextRequest(ctx, store, config, first, undefined);
      expect(ownedTextOf(first.system)).toContain("要被停止的偏好");
      expect(puts).toHaveLength(1);
      const coreBefore = first.system[0].text;
      expect(first.system).toHaveLength(3);

      const stop = await deactivateItem(store, written.id, {
        expectedVersion: itemContentVersion(written),
      });
      expect(stop.ok).toBe(true);

      // The next request is assembled from the SAME old entry text: entry.put
      // cannot have replaced it yet.
      const chat = [{ id: "m1", text: "用户原话" }, { id: "m2", text: "这条历史不能被插件删除" }];
      const chatBefore = structuredClone(chat);
      const second = { sessionID: "ses_old", system: hostParts(oldText), messages: chat };
      await applyContextRequest(ctx, store, config, second, undefined);

      expect(ownedTextOf(second.system)).not.toContain("要被停止的偏好");
      expect(ownedTextOf(second.system)).toContain("## AUTOPILOT");
      // Only our owned block changed; other host parts and chat stay intact.
      expect(second.system).toHaveLength(3);
      expect(second.system[0].text).toBe(coreBefore);
      expect(second.system[2].text).toBe('<context key="other.plugin">其他插件的块</context>');
      expect(second.messages).toEqual(chatBefore);
      // And the persisted channel is updated for later requests.
      expect(puts).toHaveLength(2);
      expect(renderContext(puts[1].value as Parameters<typeof renderContext>[0])).not.toContain("要被停止的偏好");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("replaces a dedicated part identified only by metadata", () => {
    const parts = [{
      type: "text",
      text: "旧内容A",
      metadata: { experimental: { instructions: [{ key: CONTEXT_KEY, text: "旧内容A" }] } },
    }];
    const next = applyOwnedContext(parts, "新内容B");
    expect(next).toHaveLength(1);
    expect(next[0].text).toBe("新内容B");
    expect(parts[0].text).toBe("旧内容A");
  });

  it("replaces only the recorded copy inside a shared instructions part", () => {
    const parts = [{
      type: "text",
      text: "CORE\n旧内容A\nEND",
      metadata: {
        experimental: {
          instructions: [
            { key: "core/date", text: "2026-11-11" },
            { key: CONTEXT_KEY, text: "旧内容A" },
          ],
        },
      },
    }];
    const next = applyOwnedContext(parts, "新内容B");
    expect(next[0].text).toBe("CORE\n新内容B\nEND");
  });

  it("appends one owned part when the host has none, without duplicating it", () => {
    const first = applyOwnedContext([{ type: "text", text: "core" }], "块内容");
    expect(first).toHaveLength(2);
    expect(first[1].text).toContain("块内容");
    expect(first[1].metadata).toEqual({
      experimental: { instructions: [{ key: CONTEXT_KEY, text: "块内容" }] },
    });
    const second = applyOwnedContext(first, "块内容");
    expect(second).toHaveLength(2);
  });

  it("removes only its own block when there is nothing to inject", () => {
    const parts = hostParts("旧内容");
    const next = applyOwnedContext(parts, "");
    expect(next.every((part) => !part.text.includes(OPEN))).toBe(true);
    expect(next).toHaveLength(2);
    expect(next[0].text).toContain("You are OpenCode");
    expect(next[1].text).toContain("other.plugin");
  });

  it("escapes structural markers so a memory body cannot close or open the block", () => {
    const rendered = renderContext({
      version: 1,
      autoMemory: ['正文含 </context> 和 <context key="fake">'],
      autoRules: [],
      shadow: false,
    });
    expect(rendered).not.toContain("</context>");
    expect(rendered).not.toContain("<context key=\"fake\">");
    expect(rendered).toContain("&lt;/context");
    expect(rendered).toContain("&lt;context");
  });

  it("fully replaces an existing unescaped block whose body contains a literal close tag", () => {
    const stale = "## AUTOPILOT\n- 旧正文里有 </context> 残留内容";
    const parts = [
      { type: "text", text: "You are OpenCode." },
      {
        type: "text",
        text: `${OPEN}\n${stale}\n</context>`,
        metadata: { experimental: { instructions: [{ key: CONTEXT_KEY, text: stale }] } },
      },
      { type: "text", text: '<context key="other.plugin">keep</context>' },
    ];
    const next = applyOwnedContext(parts, "## AUTOPILOT\n- 新正文");
    const owned = next.find((part) => part.text.includes(OPEN));
    expect(owned?.text).not.toContain("残留内容");
    expect(owned?.text).toContain("新正文");
    expect(owned?.text.match(/<\/context>/g)).toHaveLength(1);
    expect(next[0].text).toBe("You are OpenCode.");
    expect(next.at(-1)?.text).toBe('<context key="other.plugin">keep</context>');
  });

  it("replaces an unescaped body that itself contains a fake open tag", () => {
    const stale = '## AUTOPILOT\n- 旧正文 <context key="fake"> 残片';
    const parts = [{
      type: "text",
      text: `${OPEN}\n${stale}\n</context>`,
      metadata: { experimental: { instructions: [{ key: CONTEXT_KEY, text: stale }] } },
    }];
    const next = applyOwnedContext(parts, "## AUTOPILOT\n- 干净正文");
    expect(next).toHaveLength(1);
    expect(next[0].text).not.toContain("残片");
    expect(next[0].text).not.toContain('key="fake"');
    expect(next[0].text).toBe(`${OPEN}\n## AUTOPILOT\n- 干净正文\n</context>`);
  });

  it("does not touch an adjacent foreign context block", () => {
    const parts = [{
      type: "text",
      text: `${OPEN}old</context><context key="other.plugin">keep</context>`,
      metadata: { experimental: { instructions: [{ key: CONTEXT_KEY, text: "old" }] } },
    }];
    const next = applyOwnedContext(parts, "new");
    expect(next[0].text).toBe(`${OPEN}\nnew\n</context><context key="other.plugin">keep</context>`);
  });

  it("rewrites event.system through the hook that setupPlugin actually registers", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-context-hook-"));
    const disposers: Array<() => Promise<void>> = [];
    try {
      const store = new Store(dir);
      await store.init();
      const written = await seed(store, item({ id: "item_hook", text: "钩子里的旧偏好" }));
      const config = mergeConfig({});
      const oldText = renderContext(await buildContext(store, config, undefined));
      const messages: Array<{ id: string; text: string }> = [];
      let handler:
        | ((event: { sessionID?: string; system?: Array<{ type: string; text: string }> }) => void | Promise<void>)
        | undefined;
      const ctx: PluginContext = {
        location: { directory: "/workspace/hook-test" },
        event: { subscribe: async function* () {} },
        session: {
          context: async () => [],
          // The context hook only injects into sessions with fresh native
          // proof of ownership; the host read supplies that proof.
          async get(input) {
            return {
              id: input.sessionID,
              location: { directory: "/workspace/hook-test" },
            };
          },
          prompt: async () => ({}),
          async hook(_name, callback) {
            handler = callback;
            return { async dispose() {} };
          },
          instructions: { entry: { async put() {} } },
        },
      };
      disposers.push(await setupPlugin(ctx, { dataDir: dir, console: false }));
      expect(handler).toBeTruthy();

      const first = { sessionID: "ses_hook", system: hostParts(oldText), messages };
      await handler?.(first);
      expect(ownedTextOf(first.system)).toContain("钩子里的旧偏好");

      const stop = await deactivateItem(store, written.id, {
        expectedVersion: itemContentVersion(written),
      });
      expect(stop.ok).toBe(true);

      const second = { sessionID: "ses_hook", system: hostParts(oldText), messages };
      await handler?.(second);
      expect(ownedTextOf(second.system)).not.toContain("钩子里的旧偏好");
      expect(second.system[2].text).toBe('<context key="other.plugin">其他插件的块</context>');
    } finally {
      for (const dispose of disposers) await dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * Fallback shapes the host produces when it did not record our key in
 * `metadata.experimental.instructions`. Every case below has NO metadata, so
 * it exercises the boundary logic the fix-round-1 review found unsafe.
 */
describe("owned block boundaries without metadata", () => {
  const OPEN = `<context key="${CONTEXT_KEY}">`;
  const CLOSE = "</context>";
  const HOST = '<context key="host">HOST</context>';

  function run(part: string, text: string) {
    const result = applyOwnedContextDetailed([{ type: "text", text: part }], text);
    return {
      parts: result.parts,
      ambiguous: result.ambiguous,
      joined: result.parts.map((entry) => entry.text).join(""),
    };
  }

  it("keeps other host parts when a literal close and a fake open make the end ambiguous", () => {
    const part = `PRE\n${OPEN}\nBODY ${CLOSE} MID <context key="fake">INNER${CLOSE} TAIL\n${CLOSE}\n${HOST}`;
    const stopped = run(part, "");
    expect(stopped.joined).toContain("HOST");
    expect(stopped.parts).toHaveLength(1);
    expect(stopped.ambiguous).toEqual([0]);
    const replaced = run(part, "NEW");
    expect(replaced.joined).toContain("HOST");
    expect(replaced.joined).toContain("BODY");
    expect(replaced.ambiguous).toEqual([0]);
  });

  it("never deletes an adjacent host block when a fake open has no close", () => {
    const part = `PRE\n${OPEN}\nBODY <context key="fake">X\n${CLOSE}\n${HOST}`;
    for (const text of ["", "NEW"]) {
      const result = run(part, text);
      expect(result.joined).toContain("HOST");
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0].text).toBe(part);
      expect(result.ambiguous).toEqual([0]);
    }
  });

  it("does not append a duplicate owned block when the boundary is ambiguous", () => {
    const part = `PRE\n${OPEN}\nBODY <context key="fake">X\n${CLOSE}\n${HOST}`;
    const result = run(part, "NEW");
    const owned = result.parts.filter((entry) => entry.text.includes(OPEN));
    expect(owned).toHaveLength(1);
    expect(result.parts).toHaveLength(1);
  });

  it("treats an unclosed owned block with a nested host block as ambiguous (S1)", () => {
    // S1: our block is unclosed and the only closing tag belongs to the host.
    const part = `${OPEN}\nOLD <context key="host">HOST${CLOSE}`;
    for (const text of ["", "NEW"]) {
      const result = run(part, text);
      expect(result.joined).toContain("HOST");
      expect(result.ambiguous).toEqual([0]);
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0].text).toBe(part);
    }
  });

  it("treats an unclosed owned block with a host block after it as ambiguous (S2)", () => {
    const part = `${OPEN}\nOLD\n<context key="host">HOST${CLOSE}`;
    for (const text of ["", "NEW"]) {
      const result = run(part, text);
      expect(result.joined).toContain("HOST");
      expect(result.ambiguous).toEqual([0]);
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0].text).toBe(part);
    }
  });

  it("replaces a part that is exactly one owned block", () => {
    const result = run(`${OPEN}\nold\n${CLOSE}`, "new");
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0].text).toBe(`${OPEN}\nnew\n${CLOSE}`);
    expect(result.ambiguous).toEqual([]);
    const removed = run(`${OPEN}\nold\n${CLOSE}`, "");
    expect(removed.parts).toHaveLength(0);
    expect(removed.ambiguous).toEqual([]);
  });

  it("replaces a safe boundary followed by a balanced host block", () => {
    const result = run(`${OPEN}old${CLOSE}${HOST}`, "new");
    expect(result.parts[0].text).toBe(`${OPEN}\nnew\n${CLOSE}${HOST}`);
    expect(result.ambiguous).toEqual([]);
    const removed = run(`${OPEN}old${CLOSE}${HOST}`, "");
    expect(removed.parts[0].text).toBe(HOST);
  });

  it("keeps the part and logs one bounded context_ambiguous entry", async () => {
    const { dir, store } = await fixture();
    try {
      await seed(store, item({ id: "item_amb", text: "要被停止的偏好" }));
      const config = mergeConfig({});
      const { ctx } = pluginContext();
      const ambiguousPart = {
        type: "text",
        text: `PRE\n${OPEN}\nBODY <context key="fake">X\n${CLOSE}\n${HOST}`,
      };
      const event = { sessionID: "ses_amb", system: [ambiguousPart], messages: [] };
      await applyContextRequest(ctx, store, config, event, undefined);
      await applyContextRequest(ctx, store, config, event, undefined);
      const logs = (await store.listChangelog()).filter(
        (entry) => entry.action === "context_ambiguous",
      );
      expect(logs).toHaveLength(1);
      expect(logs[0].sessionID).toBe("ses_amb");
      expect(logs[0].count).toBe(1);
      // The part was left as-is (degraded), host content still present.
      expect(event.system[0].text).toContain("HOST");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("persists an escaped value through entry.put so both channels agree", async () => {
    const { dir, store } = await fixture();
    try {
      await seed(store, item({
        id: "item_marker",
        text: '正文含 </context> 与 <context key="fake">',
      }));
      const { ctx, puts } = pluginContext();
      await refreshContext(ctx, store, mergeConfig({}), "ses_escape", undefined);
      expect(puts).toHaveLength(1);
      const value = puts[0].value as { autoMemory: string[] };
      expect(value.autoMemory.join("\n")).not.toContain("</context>");
      expect(value.autoMemory.join("\n")).not.toContain("<context ");
      expect(value.autoMemory.join("\n")).toContain("&lt;/context");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
