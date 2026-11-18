import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import {
  RECALL_HEADER,
  attachRecallBlock,
  type RecallSystemPart,
} from "../src/recall.js";
import { ownershipParentState } from "../src/plugin.js";
import type { NativeSessionIdentity } from "../src/session/provenance.js";
import type { Item } from "../src/types.js";

/**
 * V2 context hook adapter. Tests call `attachRecallBlock` directly with a fake
 * `system` array and a seeded temp Store, so no host, model or network is
 * involved. The hook itself is exercised once in plugin-wiring.test.ts.
 */

const SENTINEL = "<!-- openmem-recall-block -->";
const now = new Date().toISOString();
const source = { sessionID: "s1", messageID: "m1", role: "user" as const };

function item(text: string, overrides: Partial<Item> = {}): Item {
  return {
    id: "item_1",
    title: "t",
    text,
    kind: "fact",
    scope: "global",
    status: "auto",
    source,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-context-recall-"));
  const store = new Store(dir);
  await store.init();
  return { dir, store };
}

function hostParts(): RecallSystemPart[] {
  return [
    { type: "text", text: "You are OpenCode." },
    { type: "text", text: '<context key="other.plugin">keep</context>' },
  ];
}

function staleRecallPart(): RecallSystemPart {
  return {
    type: "text",
    text: `${RECALL_HEADER}\n- [global/fact] 旧动态块\n${SENTINEL}`,
  };
}

function recallParts(system: ReadonlyArray<RecallSystemPart>): RecallSystemPart[] {
  return system.filter((part) => part.text.includes(RECALL_HEADER));
}

const enabled = () => mergeConfig({ recall: { enabled: true } });

describe("P04 ownership parent tri-state", () => {
  function identity(overrides: Partial<NativeSessionIdentity> = {}): NativeSessionIdentity {
    return {
      id: "ses_1",
      parentKnown: false,
      directories: ["/workspace/A"],
      ...overrides,
    };
  }

  it("calls an owned, host-read, id-matched read without parentID root", () => {
    expect(
      ownershipParentState(
        { status: "owned", hostRead: true, identity: identity() },
        "ses_1",
      ),
    ).toBe("root");
    // An explicit null parent slot is the same answer as an omission.
    expect(
      ownershipParentState(
        { status: "owned", hostRead: true, identity: identity({ parentKnown: true }) },
        "ses_1",
      ),
    ).toBe("root");
    expect(
      ownershipParentState(
        {
          status: "owned",
          hostRead: true,
          identity: identity({ parentKnown: true, parentID: "ses_parent" }),
        },
        "ses_1",
      ),
    ).toBe("child");
  });

  it("stays unknown for unowned, unhosted, unavailable or mismatched reads", () => {
    const cases = [
      undefined,
      { status: "unavailable", hostRead: false },
      { status: "mismatch", hostRead: false },
      { status: "foreign", hostRead: true },
      // Owned from a fresh event but without a host read: not proof.
      { status: "owned", hostRead: false, identity: identity() },
      // No id to match.
      { status: "owned", hostRead: true },
      { status: "owned", hostRead: true, identity: identity({ id: undefined }) },
      // Id of another session.
      { status: "owned", hostRead: true, identity: identity({ id: "ses_other" }) },
    ];
    for (const ownership of cases) {
      expect(ownershipParentState(ownership, "ses_1")).toBe("unknown");
    }
  });
});

describe("P04 context recall injection", () => {
  it("injects one bounded block for a proven root", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);
      const system = hostParts();
      const messages = [{ role: "user", text: "上次复盘失败为什么" }];

      await attachRecallBlock(
        { sessionID: "ses_root", messages, system, parentState: "root" },
        { store, config: enabled() },
      );

      const injected = recallParts(system);
      expect(injected).toHaveLength(1);
      expect(injected[0].text).toContain(RECALL_HEADER);
      expect(injected[0].text).toContain("复盘失败的原因是缓存");
      expect(injected[0].text.trimEnd().endsWith(SENTINEL)).toBe(true);
      expect(injected[0].metadata).toEqual({
        openmem: { block: "recall", version: 1 },
      });
      expect(system.slice(0, 2)).toEqual(hostParts());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a child and any unknown parent state", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);
      const messages = [{ role: "user", text: "上次复盘失败为什么" }];

      for (const parentState of ["child", "unknown"] as const) {
        const system = hostParts();
        await attachRecallBlock(
          { sessionID: "ses_x", messages, system, parentState },
          { store, config: enabled() },
        );
        expect(system).toEqual(hostParts());
      }

      // An explicit parentID wins even if the caller guessed root, and an
      // absent parentState is unknown, never root by default.
      const withParentID = hostParts();
      await attachRecallBlock(
        {
          sessionID: "ses_x",
          messages,
          system: withParentID,
          parentState: "root",
          parentSessionID: "parent-1",
        },
        { store, config: enabled() },
      );
      expect(withParentID).toEqual(hostParts());

      const absent = hostParts();
      await attachRecallBlock(
        { sessionID: "ses_x", messages, system: absent },
        { store, config: enabled() },
      );
      expect(absent).toEqual(hostParts());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queries only the last contiguous user segment and never crosses a boundary", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([
        item("复盘失败的原因是缓存", { id: "item_old_topic" }),
        item("端口是 5199", { id: "item_current" }),
      ]);
      const system = hostParts();
      const messages = [
        { role: "user", text: "复盘失败为什么" },
        { role: "assistant", text: "done" },
        { role: "user", text: "端口是多少" },
        // A synthetic user turn is skipped inside the same segment, so the
        // previous real user message of this segment is still the query.
        { role: "user", text: '<context key="host">synthetic</context>' },
      ];

      await attachRecallBlock(
        { sessionID: "ses_root", messages, system, parentState: "root" },
        { store, config: enabled() },
      );

      const injected = recallParts(system);
      expect(injected).toHaveLength(1);
      expect(injected[0].text).toContain("端口是 5199");
      expect(injected[0].text).not.toContain("复盘失败的原因是缓存");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not inject on a tool or assistant turn", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);

      for (const trailing of [
        { role: "assistant", text: "done" },
        { role: "tool", text: "npm run verify" },
      ]) {
        const system = hostParts();
        await attachRecallBlock(
          {
            sessionID: "ses_root",
            messages: [{ role: "user", text: "复盘失败为什么" }, trailing],
            system,
            parentState: "root",
          },
          { store, config: enabled() },
        );
        expect(system).toEqual(hostParts());
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps at most one dynamic part across repeated calls", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);
      const system = hostParts();
      const messages = [{ role: "user", text: "复盘失败为什么" }];
      const input = {
        sessionID: "ses_root",
        messages,
        system,
        parentState: "root" as const,
      };

      await attachRecallBlock(input, { store, config: enabled() });
      const first = structuredClone(system);
      expect(recallParts(system)).toHaveLength(1);

      await attachRecallBlock(input, { store, config: enabled() });
      expect(recallParts(system)).toHaveLength(1);
      expect(system).toEqual(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing to the transcript, session state or items", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);
      await store.updateSession("ses_write", {
        contextProjectKey: "P1",
        sessionDirectory: "/workspace/A",
      });
      const sessionBefore = structuredClone(await store.readSession("ses_write"));
      const itemsBefore = structuredClone(await store.listItems());
      const changelogBefore = (await store.listChangelog()).length;
      const messages = [{ role: "user", text: "复盘失败为什么" }];
      const messagesBefore = structuredClone(messages);
      const system = hostParts();

      const updateSession = vi.spyOn(Store.prototype, "updateSession");
      const appendItem = vi.spyOn(Store.prototype, "appendItem");
      const replaceItems = vi.spyOn(Store.prototype, "replaceItems");
      const writeConfig = vi.spyOn(Store.prototype, "writeConfig");
      try {
        // attachRecallBlock has no entry dependency at all, so `entry.put`
        // cannot be reached from this adapter.
        await attachRecallBlock(
          { sessionID: "ses_write", messages, system, parentState: "root" },
          { store, config: enabled() },
        );
        expect(recallParts(system)).toHaveLength(1);
        expect(updateSession).not.toHaveBeenCalled();
        expect(appendItem).not.toHaveBeenCalled();
        expect(replaceItems).not.toHaveBeenCalled();
        expect(writeConfig).not.toHaveBeenCalled();
      } finally {
        updateSession.mockRestore();
        appendItem.mockRestore();
        replaceItems.mockRestore();
        writeConfig.mockRestore();
      }

      expect(messages).toEqual(messagesBefore);
      expect(await store.readSession("ses_write")).toEqual(sessionBefore);
      expect(await store.listItems()).toEqual(itemsBefore);
      expect(await store.listChangelog()).toHaveLength(changelogBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps host parts and user text byte-identical", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);
      const core = 'You are OpenCode.\n<context key="core/date">2026-11-11</context>';
      const system: RecallSystemPart[] = [
        {
          type: "text",
          text: core,
          metadata: { experimental: { instructions: [{ key: "core/date" }] } },
        },
        { type: "text", text: "  leading and trailing spaces  " },
      ];
      const coreBefore = structuredClone(system);
      const messages = [
        { role: "user", text: "  复盘失败为什么  " },
        { role: "user", text: "保留原文\n第二行" },
      ];
      const messagesBefore = structuredClone(messages);

      await attachRecallBlock(
        { sessionID: "ses_root", messages, system, parentState: "root" },
        { store, config: enabled() },
      );

      expect(system.slice(0, 2)).toEqual(coreBefore);
      expect(messages).toEqual(messagesBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never injects a revoked or expired item", async () => {
    const { dir, store } = await fixture();
    const base = Date.parse("2026-06-01T00:00:00.000Z");
    try {
      await store.replaceItems([
        item("复盘失败的原因是过期缓存", {
          id: "item_expired",
          expiresAt: new Date(base - 1_000).toISOString(),
        }),
        item("复盘失败的原因是失效记录", {
          id: "item_invalid",
          invalidatedBy: "item_upstream",
          invalidatedAt: new Date(base).toISOString(),
        }),
        item("复盘失败的原因是归档结论", { id: "item_archived", status: "archived" }),
        item("复盘失败的原因是当前缓存", { id: "item_active" }),
      ]);
      const system = hostParts();

      await attachRecallBlock(
        {
          sessionID: "ses_root",
          messages: [{ role: "user", text: "复盘失败为什么" }],
          system,
          parentState: "root",
        },
        { store, config: enabled(), now: () => base },
      );

      const injected = recallParts(system);
      expect(injected).toHaveLength(1);
      expect(injected[0].text).toContain("复盘失败的原因是当前缓存");
      expect(injected[0].text).not.toContain("过期缓存");
      expect(injected[0].text).not.toContain("失效记录");
      expect(injected[0].text).not.toContain("归档结论");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("follows the recall.enabled default matrix and still strips stale blocks", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);
      const messages = [{ role: "user", text: "复盘失败为什么" }];
      const cases: Array<{ label: string; config: ReturnType<typeof mergeConfig>; inject: boolean }> = [
        {
          label: "automation off, recall unset",
          config: mergeConfig({ automation: { enabled: false } }),
          inject: false,
        },
        {
          label: "automation on, recall unset",
          config: mergeConfig({ automation: { enabled: true } }),
          inject: true,
        },
        {
          label: "automation on, recall false",
          config: mergeConfig({ automation: { enabled: true }, recall: { enabled: false } }),
          inject: false,
        },
        {
          label: "automation off, recall true",
          config: mergeConfig({ automation: { enabled: false }, recall: { enabled: true } }),
          inject: true,
        },
      ];

      for (const testCase of cases) {
        const system = [...hostParts(), staleRecallPart()];
        await attachRecallBlock(
          { sessionID: "ses_root", messages, system, parentState: "root" },
          { store, config: testCase.config },
        );
        expect({ label: testCase.label, injected: recallParts(system).length }).toEqual({
          label: testCase.label,
          injected: testCase.inject ? 1 : 0,
        });
        expect(system.slice(0, 2)).toEqual(hostParts());
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the request untouched when recall fails", async () => {
    const { dir, store } = await fixture();
    try {
      const system = hostParts();
      const systemBefore = structuredClone(system);
      const messages = [{ role: "user", text: "复盘失败为什么" }];
      const messagesBefore = structuredClone(messages);
      const spy = vi
        .spyOn(Store.prototype, "listItems")
        .mockRejectedValueOnce(new Error("synthetic state read failure"));
      try {
        await expect(
          attachRecallBlock(
            { sessionID: "ses_root", messages, system, parentState: "root" },
            { store, config: enabled() },
          ),
        ).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      expect(system).toEqual(systemBefore);
      expect(messages).toEqual(messagesBefore);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not inject for an irrelevant prompt", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);
      const system = hostParts();
      const messages = [{ role: "user", text: "今天天气怎么样" }];

      await attachRecallBlock(
        { sessionID: "ses_root", messages, system, parentState: "root" },
        { store, config: enabled() },
      );

      expect(recallParts(system)).toHaveLength(0);
      expect(system).toEqual(hostParts());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not inject for a short command or a synthetic prompt", async () => {
    const { dir, store } = await fixture();
    try {
      await store.replaceItems([item("复盘失败的原因是缓存", { id: "item_recall" })]);

      for (const text of [
        "/status",
        "ok",
        '<system-update><context key="host">{"warming":true}</context></system-update>',
      ]) {
        const system = hostParts();
        await attachRecallBlock(
          {
            sessionID: "ses_root",
            messages: [{ role: "user", text }],
            system,
            parentState: "root",
          },
          { store, config: enabled() },
        );
        expect({ text, injected: recallParts(system).length }).toEqual({
          text,
          injected: 0,
        });
        expect(system).toEqual(hostParts());
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
