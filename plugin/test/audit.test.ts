import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runAudit } from "../src/audit.js";
import type { Item, QueueItem, ShadowRecord, SkillDraft } from "../src/types.js";

const now = new Date();
const iso = now.toISOString();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86400000).toISOString();

function item(
  id: string,
  title: string,
  text: string,
  createdAt = iso,
): Item {
  return {
    id,
    title,
    text,
    kind: "rule",
    scope: "global",
    status: "auto",
    source: {},
    createdAt,
    updatedAt: createdAt,
  };
}

function queue(id: string, title: string, text: string, createdAt = iso): QueueItem {
  return { ...item(id, title, text, createdAt), status: "queue", reason: "test" };
}

function shadow(id: string, falsePositive: boolean): ShadowRecord {
  return {
    id,
    candidate: "shadow candidate",
    title: `[F] shadow ${id}`,
    kind: "fact",
    scope: "global",
    wouldWriteTo: "AUTO_MEMORY.md",
    wouldApply: 1,
    jev: {
      kind: "fact",
      duplicate: 0,
      safeAuto: 0.96,
      risk: 0.1,
      confidence: 0.9,
      strictness: "unknown",
      reasons: [],
      source: "heuristic",
    },
    priority: 20,
    source: {},
    createdAt: iso,
    falsePositive,
    falsePositiveAt: falsePositive ? iso : undefined,
  };
}

describe("runAudit", () => {
  it("detects duplicate, secret, stale, queue, shadow, and skill findings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-audit-"));
    try {
      const store = new Store(dir);
      await store.init();
      await store.appendItem(item("a1", "[R] duplicate", "同样的规则文本"));
      await store.appendItem(item("a2", "[R] duplicate", "同样的规则文本"));
      await store.appendItem(item("sec", "[F] key", "api_key=sk-0000000000000000"));
      await store.appendItem(item("old", "[F] old", "很久以前的事实", daysAgo(100)));
      await store.upsertQueue(queue("q-old", "[R] old queue", "等待很久的规则", daysAgo(10)));
      await store.appendShadow(shadow("s1", true));
      await store.appendShadow(shadow("s2", true));

      const invalid: SkillDraft = {
        id: "bad-skill",
        name: "Bad Skill",
        description: "no trigger",
        status: "draft",
        path: "",
        validation: { ok: false, errors: [], warnings: [] },
        createdAt: iso,
        updatedAt: iso,
      };
      await store.writeSkillDraft(invalid, "# no frontmatter\n");

      const report = await runAudit(store, DEFAULT_CONFIG);
      const kinds = new Set(report.findings.map((finding) => finding.kind));
      expect(kinds.has("duplicate")).toBe(true);
      expect(kinds.has("secret")).toBe(true);
      expect(kinds.has("stale")).toBe(true);
      expect(kinds.has("queue")).toBe(true);
      expect(kinds.has("shadow")).toBe(true);
      expect(kinds.has("skill")).toBe(true);
      expect(report.summary.error).toBeGreaterThan(0);
      expect(report.summary.warning).toBeGreaterThan(0);

      const metrics = await store.readMetrics();
      expect(metrics.auditFindings).toBe(report.findings.length);
      expect(metrics.queueAgeP50Hours).toBeGreaterThan(200);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
