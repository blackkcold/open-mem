import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectBackup } from "../src/backup.js";

const domainFiles = {
  l0: "global-entry/AGENTS.md",
  l1: "openchamber-memory/global.json",
  openmem: "global-memory/autopilot/items.jsonl",
  project: "project-memory/PROJECT.md",
  logic: "logic-chain/README.md",
} as const;

async function writeAt(root: string, relative: string, content = "x"): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function seedSnapshot(
  root: string,
  name: string,
  domains: Array<keyof typeof domainFiles>,
): Promise<string> {
  const snapshot = path.join(root, name);
  for (const domain of domains) {
    await writeAt(snapshot, domainFiles[domain]);
  }
  return snapshot;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("inspectBackup", () => {
  it("does not invent a snapshot when the backup root is empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-empty-"));
    try {
      const status = await inspectBackup(dir);
      expect(status.snapshotPresent).toBe(false);
      expect(status.integrity).toBe("unknown");
      expect(status.freshness).toBe("unknown");
      expect(status.restoreSupport).toBe("unknown");
      expect(status.coverage.present).toBe(0);
      expect(status.coverage.missing).toHaveLength(5);
      expect(status.domains).toHaveLength(5);
      expect(status.domains.every((domain) => domain.state === "missing")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports partial coverage instead of calling one domain complete", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-partial-"));
    try {
      await seedSnapshot(dir, "backup-20260101-100000", ["l0"]);
      const status = await inspectBackup(dir);
      expect(status.snapshotPresent).toBe(true);
      expect(status.latest?.complete).toBe(false);
      expect(status.latest?.coverage).toMatchObject({ required: 5, present: 1 });
      expect(status.latest?.coverage.missing).toEqual(
        expect.arrayContaining([
          domainFiles.l1,
          domainFiles.openmem,
          "project-memory",
          "logic-chain",
        ]),
      );
      expect(status.latestComplete).toBeUndefined();
      expect(status.notes.join(" ")).toContain("没有更早的结构完整快照");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks a zero-byte required file as corrupt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-zero-"));
    try {
      const snapshot = path.join(dir, "backup-20260101-100000");
      await writeAt(snapshot, domainFiles.l0, "");
      const status = await inspectBackup(dir);
      expect(status.integrity).toBe("corrupt");
      expect(status.latest?.domains.find((domain) => domain.id === "l0")?.integrity).toBe(
        "corrupt",
      );
      expect(status.latest?.domains.find((domain) => domain.id === "l0")?.notes.join(" ")).toContain(
        "0 字节",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verifies manifest checksums and treats an unverified manifest as partial", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-manifest-"));
    try {
      const snapshot = await seedSnapshot(dir, "backup-20260101-100000", [
        "l0",
        "l1",
        "openmem",
        "project",
        "logic",
      ]);
      await writeFile(
        path.join(snapshot, "manifest.json"),
        JSON.stringify({
          createdAt: new Date().toISOString(),
          files: [{ path: domainFiles.l0, sha256: sha256("x") }],
        }),
        "utf8",
      );
      const verified = await inspectBackup(dir);
      expect(verified.integrity).toBe("verified");
      expect(verified.latest?.complete).toBe(true);

      await writeFile(
        path.join(snapshot, "manifest.json"),
        JSON.stringify({
          createdAt: new Date().toISOString(),
          files: [{ path: domainFiles.l0, sha256: "deadbeef" }],
        }),
        "utf8",
      );
      expect((await inspectBackup(dir)).integrity).toBe("corrupt");

      await writeFile(
        path.join(snapshot, "manifest.json"),
        JSON.stringify({ createdAt: new Date().toISOString() }),
        "utf8",
      );
      expect((await inspectBackup(dir)).integrity).toBe("partial");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not let a half-finished latest directory hide the last complete snapshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-latest-"));
    try {
      await seedSnapshot(dir, "backup-20260101-100000", [
        "l0",
        "l1",
        "openmem",
        "project",
        "logic",
      ]);
      await seedSnapshot(dir, "backup-20260102-100000", ["l0"]);
      const status = await inspectBackup(dir, { now: new Date("2026-01-03T00:00:00Z") });
      expect(status.latest?.name).toBe("backup-20260102-100000");
      expect(status.latest?.complete).toBe(false);
      expect(status.latestComplete?.name).toBe("backup-20260101-100000");
      expect(status.notes.join(" ")).toContain("最近结构完整快照");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("only claims manual restore from a script and requires a passed drill", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-restore-"));
    try {
      const snapshot = await seedSnapshot(dir, "backup-20260101-100000", [
        "l0",
        "l1",
        "openmem",
        "project",
        "logic",
      ]);
      const withoutDrill = await inspectBackup(dir, {
        rollbackScript: "restore_openchamber_memory() { :; }",
      });
      expect(withoutDrill.restoreSupport).toBe("unknown");
      expect(
        withoutDrill.domains.find((domain) => domain.id === "l1")?.restoreSupport,
      ).toBe("unknown");
      expect(
        withoutDrill.domains.find((domain) => domain.id === "l0")?.restoreSupport,
      ).toBe("unknown");

      await writeFile(
        path.join(snapshot, "restore-drill.json"),
        JSON.stringify({ at: new Date().toISOString(), result: "passed" }),
        "utf8",
      );
      const manual = await inspectBackup(dir, {
        rollbackScript: "restore_openchamber_memory() { :; }",
      });
      expect(manual.restoreSupport).toBe("manual");
      expect(manual.domains.find((domain) => domain.id === "l1")?.restoreSupport).toBe(
        "manual",
      );
      expect(manual.domains.find((domain) => domain.id === "l0")?.restoreSupport).toBe(
        "none",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks stale snapshots and empty domain directories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-stale-"));
    try {
      const snapshot = await seedSnapshot(dir, "backup-20260101-100000", ["l0"]);
      await mkdir(path.join(snapshot, "project-memory"), { recursive: true });
      await mkdir(path.join(snapshot, "logic-chain"), { recursive: true });
      const status = await inspectBackup(dir, { now: new Date("2026-02-01T00:00:00Z") });
      expect(status.freshness).toBe("stale");
      expect(status.domains.find((domain) => domain.id === "project")?.state).toBe(
        "missing",
      );
      expect(status.domains.find((domain) => domain.id === "project")?.notes.join(" ")).toContain(
        "目录为空",
      );
      expect(status.domains.find((domain) => domain.id === "logic")?.state).toBe(
        "missing",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not inherit snapshot integrity or restore into a missing domain", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-domain-"));
    try {
      const snapshot = await seedSnapshot(dir, "backup-20260101-100000", ["l0"]);
      await writeFile(
        path.join(snapshot, "manifest.json"),
        JSON.stringify({
          createdAt: new Date().toISOString(),
          files: [{ path: domainFiles.l0, sha256: sha256("x") }],
          restore: { automatic: true },
        }),
        "utf8",
      );
      await writeFile(
        path.join(snapshot, "restore-drill.json"),
        JSON.stringify({ at: new Date().toISOString(), result: "passed" }),
        "utf8",
      );
      const status = await inspectBackup(dir, {
        rollbackScript: "restore_openchamber_memory() { :; }",
      });
      const l0 = status.domains.find((domain) => domain.id === "l0");
      const l1 = status.domains.find((domain) => domain.id === "l1");
      expect(l0?.integrity).toBe("verified");
      expect(l1).toMatchObject({
        state: "missing",
        integrity: "unknown",
        restoreSupport: "unknown",
      });
      expect(status.restoreSupport).not.toBe("automatic");
      expect(status.domains.some((domain) => domain.restoreSupport === "automatic")).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a drill record that belongs to another snapshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-drill-"));
    try {
      const snapshot = await seedSnapshot(dir, "backup-20260102-100000", [
        "l0",
        "l1",
        "openmem",
        "project",
        "logic",
      ]);
      await writeFile(
        path.join(snapshot, "restore-drill.json"),
        JSON.stringify({
          at: new Date().toISOString(),
          result: "passed",
          snapshotID: "backup-20260101-100000",
        }),
        "utf8",
      );
      const status = await inspectBackup(dir);
      expect(status.drillStatus).toBe("invalid");
      expect(status.restoreSupport).toBe("unknown");
      expect(status.latest?.drill).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("separates an unreadable domain from a missing one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openmem-backup-unknown-"));
    try {
      const snapshot = path.join(dir, "backup-20260101-100000");
      await writeAt(snapshot, domainFiles.l0);
      await writeAt(snapshot, "project-memory");
      const status = await inspectBackup(dir);
      const project = status.domains.find((domain) => domain.id === "project");
      expect(project?.state).toBe("unknown");
      expect(status.coverage.unknown).toContain("project-memory");
      expect(status.coverage.missing).not.toContain("project-memory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
