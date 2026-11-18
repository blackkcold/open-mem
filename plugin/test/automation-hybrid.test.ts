import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { mergeConfig } from "../src/config.js";
import { runExtractCreate } from "../src/extract/create.js";
import type { ExtractProvider, ExtractProposal } from "../src/extract/provider.js";
import type { SessionMessage } from "../src/types.js";

function message(id: string, text: string): SessionMessage {
  return { id, role: "user", type: "user", text };
}

function proposalFor(
  quote: string,
  subject: string,
  predicate: string,
  value: string,
): ExtractProposal {
  return {
    quote,
    kind: "preference",
    scope: "project",
    subject,
    predicate,
    value,
    qualifiers: [],
    speechActHint: "assertion",
    text: quote,
  };
}

const pnpm = (quote = "项目默认使用 pnpm") =>
  proposalFor(quote, "项目", "默认使用", "pnpm");
const port = (quote = "项目端口是 5199") =>
  proposalFor(quote, "项目端口", "是", "5199");

function providerOf(proposals: ExtractProposal[]): ExtractProvider {
  return { async extract() { return proposals; } } as unknown as ExtractProvider;
}

async function run(
  store: Store,
  config: ReturnType<typeof mergeConfig>,
  sessionID: string,
  text: string,
  proposals: ExtractProposal[],
) {
  return runExtractCreate(sessionID, "turn", {
    store,
    config,
    reader: { readForEvidence: async () => [message(`${sessionID}-m1`, text)] },
    provider: providerOf(proposals),
    projectKey: "project-A",
    ownsNativeRoot: async () => true,
  });
}

async function withStore(
  fn: (store: Store, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-hybrid-"));
  try {
    const store = new Store(dir);
    await store.init();
    await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("extract write admission", () => {
  it("holds the candidate without writing when capacity admission rejects the add", async () => {
    await withStore(async (store) => {
      const config = mergeConfig({
        shadow: false,
        automation: { enabled: true },
        caps: { autoMemory: 0 },
      });
      await store.writeConfig(config);
      const result = await run(
        store,
        config,
        "ses_capacity",
        "项目默认使用 pnpm",
        [pnpm()],
      );
      expect(result.created).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(1);
      expect(await store.listItems()).toHaveLength(0);
      const quarantine = await store.listExtractQuarantine();
      expect(quarantine.map((row) => row.reason)).toContain("auto-memory-cap");
      expect(quarantine[0]?.text).toBe("项目默认使用 pnpm");
    });
  });

  it("does not defer an enabled config that predates the new automation fields", async () => {
    await withStore(async (store, dir) => {
      // Written by an older release: no autoUpdate, dailyWrites or
      // maxWritesPerSession in the persisted file.
      await writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({
          version: 1,
          shadow: false,
          automation: { enabled: true, mode: "autonomous", revision: 0 },
        }),
      );
      const config = mergeConfig(await store.readConfig());
      expect(config.automation.dailyWrites).toBe(40);
      const result = await run(
        store,
        config,
        "ses_legacy_config",
        "项目默认使用 pnpm",
        [pnpm()],
      );
      expect(result.created).toBe(1);
      expect(result.deferred).toBeUndefined();
    });
  });

  it("quarantines a content update when autoUpdate is false but still touches seen items", async () => {
    await withStore(async (store) => {
      const config = mergeConfig({
        shadow: false,
        automation: { enabled: true, autoUpdate: false },
      });
      await store.writeConfig(config);
      const added = await run(
        store,
        config,
        "ses_update",
        "项目也默认使用 npm",
        [proposalFor("项目也默认使用 npm", "项目", "默认使用", "npm")],
      );
      expect(added.created).toBe(1);
      const [created] = await store.listItems();
      expect(created?.text).toBe("项目也默认使用 npm");

      const updated = await run(
        store,
        config,
        "ses_update_next",
        "项目还默认使用 yarn",
        [proposalFor("项目还默认使用 yarn", "项目", "默认使用", "yarn")],
      );
      expect(updated.created).toBe(0);
      expect(updated.updated).toBe(0);
      const afterUpdate = await store.listItems();
      expect(afterUpdate).toHaveLength(1);
      expect(afterUpdate[0]?.text).toBe("项目也默认使用 npm");
      expect(afterUpdate[0]?.updatedAt).toBe(created?.updatedAt);
      const quarantined = await store.listExtractQuarantine();
      expect(quarantined.map((row) => row.reason)).toContain("auto-update-disabled");
      expect(quarantined[0]?.text).toBe("项目还默认使用 yarn");

      const seen = await run(
        store,
        config,
        "ses_seen",
        "项目也默认使用 npm",
        [proposalFor("项目也默认使用 npm", "项目", "默认使用", "npm")],
      );
      expect(seen.updated ?? 0).toBe(0);
      const afterSeen = await store.listItems();
      expect(afterSeen).toHaveLength(1);
      expect(afterSeen[0]?.text).toBe("项目也默认使用 npm");
      expect(afterSeen[0]?.seenCount).toBe(2);
    });
  });

  it("appends a content update when autoUpdate keeps its default", async () => {
    await withStore(async (store) => {
      const config = mergeConfig({ shadow: false, automation: { enabled: true } });
      await store.writeConfig(config);
      const added = await run(
        store,
        config,
        "ses_default_update",
        "项目也默认使用 npm",
        [proposalFor("项目也默认使用 npm", "项目", "默认使用", "npm")],
      );
      expect(added.created).toBe(1);
      const updated = await run(
        store,
        config,
        "ses_default_update_next",
        "项目还默认使用 yarn",
        [proposalFor("项目还默认使用 yarn", "项目", "默认使用", "yarn")],
      );
      expect(updated.updated).toBe(1);
      expect((await store.listItems())[0]?.text).toBe("项目也默认使用 npm；项目还默认使用 yarn");
    });
  });

  it("holds a second add once the daily write budget is spent", async () => {
    await withStore(async (store) => {
      const config = mergeConfig({
        shadow: false,
        automation: { enabled: true, dailyWrites: 1 },
      });
      await store.writeConfig(config);
      const first = await run(
        store,
        config,
        "ses_budget_a",
        "项目默认使用 pnpm",
        [pnpm()],
      );
      expect(first.created).toBe(1);
      const second = await run(
        store,
        config,
        "ses_budget_b",
        "项目端口是 5199",
        [port()],
      );
      expect(second.created).toBe(0);
      expect(second.skipped).toBeGreaterThanOrEqual(1);
      expect(await store.listItems()).toHaveLength(1);
      const quarantine = await store.listExtractQuarantine();
      expect(quarantine.map((row) => row.reason)).toContain("write-budget");
      expect(quarantine[0]?.text).toBe("项目端口是 5199");
    });
  });
});
