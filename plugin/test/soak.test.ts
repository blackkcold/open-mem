import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeSoakPath,
  runSoak,
  DEFAULT_START_AT,
  SOAK_INVARIANTS,
} from "../../scripts/soak-core.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Evidence = Record<string, unknown>;

function numberField(evidence: Map<string, Evidence>, id: string, key: string): number {
  const value = evidence.get(id)?.[key];
  if (typeof value !== "number") throw new Error(`missing numeric evidence ${id}.${key}`);
  return value;
}

function stringField(evidence: Map<string, Evidence>, id: string, key: string): string {
  const value = evidence.get(id)?.[key];
  if (typeof value !== "string") throw new Error(`missing string evidence ${id}.${key}`);
  return value;
}

describe("3-day simulated soak", () => {
  it("holds the 16 phase06 invariants through the real consolidation path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = await mkdtemp(path.join(os.tmpdir(), "openmem-soak-"));
    try {
      vi.setSystemTime(new Date(DEFAULT_START_AT));
      const report = await runSoak({
        days: 3,
        sessions: 5,
        seed: 42,
        dataDir: path.join(root, "data"),
        checkpointRoot: path.join(root, "checkpoints"),
        setNow: (now: number) => vi.setSystemTime(new Date(now)),
      });

      expect(report.simulated).toBe(true);
      expect(report.fakeClock).toBe(true);
      expect(report.days).toBe(3);
      expect(report.sessions).toBe(5);
      expect(report.seed).toBe(42);
      expect(report.invariants.map((entry: { id: string }) => entry.id))
        .toEqual(SOAK_INVARIANTS.map((entry: { id: string }) => entry.id));
      expect(report.failures).toEqual([]);
      expect(report.invariants.filter((entry: { ok: boolean }) => !entry.ok)).toEqual([]);
      expect(report.ok).toBe(true);

      const evidence = new Map<string, Evidence>(
        report.invariants.map((entry: { id: string; evidence: Evidence }) => [entry.id, entry.evidence]),
      );

      // I01: rule/skill candidates really went through classifier + lane.
      expect(numberField(evidence, "I01", "ruleCandidates")).toBeGreaterThan(0);
      expect(numberField(evidence, "I01", "skillCandidates")).toBeGreaterThan(0);
      expect(numberField(evidence, "I01", "autoRuleSkills")).toBe(0);

      // I02: duplicates were attempted and skipped by the real write lane.
      expect(evidence.get("I02")?.duplicate).toBeNull();
      expect(numberField(evidence, "I02", "duplicateAttempts")).toBeGreaterThan(0);
      expect(numberField(evidence, "I02", "duplicateSkips")).toBeGreaterThan(0);

      // I03: stop/restore and revert/restoreVersion are real calls.
      expect(evidence.get("I03")).toMatchObject({ missing: [] });
      expect(numberField(evidence, "I03", "stops")).toBeGreaterThan(0);
      expect(numberField(evidence, "I03", "restores")).toBeGreaterThan(0);
      expect(numberField(evidence, "I03", "reverts")).toBeGreaterThan(0);
      expect(numberField(evidence, "I03", "restoreVersions")).toBeGreaterThan(0);

      // I04: freeze gate + real write-budget bound.
      expect(evidence.get("I04")).toMatchObject({ frozenLevel: "freeze" });
      expect(evidence.get("I04")).toMatchObject({ budgetSecondBlocked: true });

      expect(evidence.get("I06")).toMatchObject({ remaining: 1 });
      expect(numberField(evidence, "I07", "blockedRelearn")).toBeGreaterThan(0);
      expect(numberField(evidence, "I07", "correctionsQueued")).toBeGreaterThan(0);
      expect(numberField(evidence, "I08", "cycleEntries")).toBeGreaterThan(0);
      expect(evidence.get("I11")).toMatchObject({ tombstoneCapBlocked: true, tombstonePruned: 0 });
      expect(evidence.get("I15")).toMatchObject({ created: 6, kept: 5 });

      // I16: the real shadow branch and the real effectiveMode endpoint.
      expect(evidence.get("I16")).toMatchObject({
        shadowWrites: 0,
        effectiveModeShadow: "shadow",
        effectiveModeAutonomous: "autonomous",
      });
      expect(numberField(evidence, "I16", "shadowRecordsDelta")).toBeGreaterThan(0);
      expect(numberField(evidence, "I16", "admittedWrites")).toBeGreaterThan(0);
      expect(report.modes).toEqual({ shadow: "shadow", autonomous: "autonomous" });
      expect(report.shadow.auto).toBe(0);
      expect(report.budget.consumedInSoak).toBeGreaterThan(0);
      expect(stringField(evidence, "I01", "ruleLane")).not.toBe("auto");
      expect(stringField(evidence, "I01", "skillLane")).not.toBe("auto");

      expect(report.retentionCounts).toMatchObject({
        changes: expect.any(Number),
        changeJournals: expect.any(Number),
        suppressions: expect.any(Number),
        quarantine: expect.any(Number),
        migrationJournals: expect.any(Number),
        checkpointBackups: expect.any(Number),
      });
      expect(report.capacityMax.ratio).toBeGreaterThan(0);
      expect(report.capacityMax.ratio).toBeLessThanOrEqual(1.0001);
      expect(report.totals.consolidationCalls).toBeGreaterThan(0);
      expect(report.totals.writes).toBeGreaterThan(0);
      expect(report.totals.stops).toBeGreaterThan(0);
      expect(report.totals.restores).toBeGreaterThan(0);
      expect(report.totals.reverts).toBeGreaterThan(0);
      expect(report.totals.restoreVersions).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses to delete shared, ancestor, or shallow paths", async () => {
    await expect(assertSafeSoakPath(path.join(REPO_ROOT, "tmp"), "repo tmp"))
      .rejects.toThrow(/refusing/);
    await expect(assertSafeSoakPath(path.join(REPO_ROOT, "tmp", "full-auto-memory"), "repo tmp family"))
      .rejects.toThrow(/refusing/);
    await expect(assertSafeSoakPath(os.tmpdir(), "temp root")).rejects.toThrow(/refusing/);
    await expect(assertSafeSoakPath(os.homedir(), "home")).rejects.toThrow(/refusing/);
    await expect(assertSafeSoakPath(path.parse(process.cwd()).root, "filesystem root"))
      .rejects.toThrow(/refusing/);
    await expect(assertSafeSoakPath(path.join(os.tmpdir(), "soak-shallow"), "shallow"))
      .rejects.toThrow(/refusing/);
    await expect(runSoak({
      days: 1,
      sessions: 1,
      dataDir: path.join(os.tmpdir(), "soak-shallow"),
    })).rejects.toThrow(/refusing/);

    const allowedRoot = await mkdtemp(path.join(os.tmpdir(), "openmem-soak-guard-"));
    try {
      const allowed = await assertSafeSoakPath(path.join(allowedRoot, "data"), "data");
      expect(path.basename(allowed)).toBe("data");
      expect(allowed).toContain("openmem-soak-guard-");
    } finally {
      await rm(allowedRoot, { recursive: true, force: true });
    }
  });
});
