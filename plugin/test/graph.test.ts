import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { buildMemoryGraph, readGraphSource } from "../src/graph.js";
import type { Item, QueueItem } from "../src/types.js";

const now = new Date().toISOString();

function item(id: string, text: string): Item {
  return {
    id,
    title: `[P] ${id}`,
    text,
    kind: "preference",
    scope: "global",
    status: "auto",
    source: {},
    createdAt: now,
    updatedAt: now,
  };
}

function queue(id: string, text: string): QueueItem {
  return { ...item(id, text), status: "queue", reason: "test" };
}

async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

describe("memory graph", () => {
  it("builds five views without leaking memory bodies", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-graph-"));
    try {
      const opencodeDir = path.join(dir, "opencode");
      const openchamberDir = path.join(dir, "openchamber");
      const backupRoot = path.join(dir, "backups");
      const logicChainDir = path.join(backupRoot, "逻辑链图");
      const projectDir = path.join(dir, "project");
      const dataDir = path.join(dir, "data");

      await write(
        path.join(opencodeDir, "AGENTS.md"),
        [
          "# Global rules",
          "",
          "## Root Trigger Matrix",
          "",
          "| Task Signal | Must Read |",
          "| --- | --- |",
          "| 删除、部署 | `memory/SAFETY_RULES.md` |",
          "",
        ].join("\n"),
      );
      await write(path.join(opencodeDir, "memory", "GLOBAL.md"), "# Global memory\n\n- rule one\n");
      await write(path.join(opencodeDir, "memory", "PENDING", "proposal.md"), "# Proposal\n");
      await write(
        path.join(opencodeDir, "scripts", "rollback-memory.sh"),
        "restore_openchamber_memory() { :; }\nrestore_project_memory() { :; }\n",
      );
      await write(
        path.join(openchamberDir, "settings.json"),
        JSON.stringify({ agentMemoryToolEnabled: false }),
      );
      await write(
        path.join(openchamberDir, "memory.json"),
        JSON.stringify({ version: 1, entries: [{ title: "a" }, { title: "b" }] }),
      );
      await write(path.join(projectDir, ".memory", "PROJECT.md"), "# Project rules\n");
      await write(path.join(logicChainDir, "README.md"), "# Logic chain\n");
      await write(path.join(backupRoot, "backup-2026-01-01_0300", "global-entry", "AGENTS.md"), "# backup\n");
      await write(
        path.join(backupRoot, "backup-2026-01-01_0300", "global-memory", "autopilot", "items.jsonl"),
        "{}\n",
      );
      await write(
        path.join(backupRoot, "backup-2026-01-01_0300", "openchamber-memory", "global.json"),
        "{}\n",
      );
      await mkdir(
        path.join(backupRoot, "backup-2026-01-01_0300", "project-memory"),
        { recursive: true },
      );

      const store = new Store(dataDir);
      await store.init();
      await store.appendItem(item("i1", "secret item body"));
      await store.appendItem(item("i2", "secret item body"));
      await store.upsertQueue(queue("q1", "secret queue body"));
      await store.appendHook({
        id: "h1",
        key: "h1",
        sessionID: "s1",
        turnID: "t1",
        messageID: "m1",
        text: "secret hook body",
        title: "[P] hook",
        trigger: "test",
        scope: "global",
        source: {},
        createdAt: now,
        updatedAt: now,
        status: "pending",
        attempts: 0,
      });

      const graph = await buildMemoryGraph({
        store,
        projectDir,
        roots: { opencodeDir, openchamberDir, backupRoot, logicChainDir },
      });

      expect(graph.sources.find((source) => source.id === "l0:agents")?.state).toBe("ready");
      expect(graph.sources.find((source) => source.id === "l1:global")?.state).toBe("disabled");
      expect(graph.sources.find((source) => source.id === "l1:global")?.entries).toBe(2);
      expect(graph.sources.find((source) => source.id === "l2:project")?.state).toBe("ready");
      expect(graph.sources.find((source) => source.id === "openmem:store")?.entries).toBe(3);
      expect(graph.sources.find((source) => source.id === "logic:chain")?.state).toBe("ready");
      expect(graph.sources.find((source) => source.id === "backup:latest")?.state).toBe("partial");

      expect(graph.views.architecture.nodes.map((node) => node.id)).toContain("layer:Backup");
      expect(graph.views.routing.summary.routes).toBe(1);
      expect(graph.views.routing.edges.some((edge) => edge.relation === "matches")).toBe(true);
      expect(graph.views.automation.summary.hooks).toBe(1);
      expect(graph.backup?.snapshotPresent).toBe(true);
      expect(
        graph.backup?.domains.find((domain) => domain.id === "l0")?.restoreSupport,
      ).toBe("unknown");
      expect(
        graph.backup?.domains.find((domain) => domain.id === "project")?.state,
      ).toBe("missing");
      expect(graph.views.backup.summary.restoreSupport).toBe("unknown");
      expect(graph.views.backup.summary.drill).toBe("missing");
      expect(graph.views.backup.summary.integrity).toBe("unknown");
      expect(graph.views.backup.summary.latestComplete).toBe("missing");
      expect(
        graph.views.backup.nodes.find((node) => node.id === "backup:openmem")?.meta?.backup,
      ).toBe("yes");
      expect(
        graph.views.backup.nodes.find((node) => node.id === "backup:logic")?.meta?.backup,
      ).toBe("no");

      const wire = JSON.stringify(graph);
      expect(wire).not.toContain("secret item body");
      expect(wire).not.toContain("secret queue body");
      expect(wire).not.toContain("secret hook body");
      for (const node of graph.views.inventory.nodes) {
        expect(node).not.toHaveProperty("text");
      }
      expect(
        graph.groups?.some(
          (group) => group.nodeIds.includes("inv:i1") && group.nodeIds.includes("inv:i2"),
        ),
      ).toBe(true);

      const detail = await readGraphSource(
        { store, projectDir, roots: { opencodeDir, openchamberDir, backupRoot, logicChainDir } },
        "l0:agents",
      );
      expect(detail?.excerpt).toContain("Root Trigger Matrix");
      expect(detail?.headings).toContain("Root Trigger Matrix");
      expect(
        await readGraphSource(
          { store, projectDir, roots: { opencodeDir, openchamberDir, backupRoot, logicChainDir } },
          "unknown",
        ),
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
