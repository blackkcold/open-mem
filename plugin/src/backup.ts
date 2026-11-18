import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export type BackupDomainID = "l0" | "l1" | "openmem" | "project" | "logic";
export type BackupDomainState = "present" | "missing" | "unknown";
export type BackupIntegrity = "verified" | "partial" | "corrupt" | "unknown";
export type BackupFreshness = "fresh" | "stale" | "unknown";
export type RestoreSupport = "automatic" | "manual" | "none" | "unknown";

export interface BackupDomainStatus {
  id: BackupDomainID;
  label: string;
  required: string[];
  present: string[];
  missing: string[];
  state: BackupDomainState;
  integrity: BackupIntegrity;
  freshness: BackupFreshness;
  restoreSupport: RestoreSupport;
  notes: string[];
}

export interface BackupCoverage {
  required: number;
  present: number;
  /** Required paths that do not exist or are empty. */
  missing: string[];
  /** Required paths that exist but could not be read or are the wrong type. */
  unknown: string[];
}

export interface BackupSnapshot {
  dir: string;
  name: string;
  createdAt?: string;
  /** Structural completeness: every required path exists. Not "verified". */
  complete: boolean | "unknown";
  integrity: BackupIntegrity;
  freshness: BackupFreshness;
  manifestPresent: boolean;
  domains: BackupDomainStatus[];
  coverage: BackupCoverage;
  drill?: BackupDrill;
  drillInvalid: boolean;
  notes: string[];
}

export interface BackupDrill {
  at: string;
  softwareVersion?: string;
  snapshotID?: string;
  result: "passed" | "failed";
}

export interface BackupStatus {
  latest?: BackupSnapshot;
  latestComplete?: BackupSnapshot;
  snapshotPresent: boolean;
  integrity: BackupIntegrity;
  freshness: BackupFreshness;
  restoreSupport: RestoreSupport;
  restoreDrill?: BackupDrill;
  /** Distinguishes "never drilled" from an unreadable or mismatched record. */
  drillStatus: "passed" | "failed" | "missing" | "invalid";
  coverage: BackupCoverage;
  domains: BackupDomainStatus[];
  manifestPresent: boolean;
  notes: string[];
}

interface DomainSpec {
  id: BackupDomainID;
  label: string;
  paths: string[];
  kind: "file" | "directory";
  restorePattern: RegExp;
}

const DOMAINS: DomainSpec[] = [
  {
    id: "l0",
    label: "L0 规则",
    paths: ["global-entry/AGENTS.md"],
    kind: "file",
    restorePattern: /restore_(?:global_entry|l0)/i,
  },
  {
    id: "l1",
    label: "OpenChamber L1",
    paths: ["openchamber-memory/global.json"],
    kind: "file",
    restorePattern: /restore_openchamber_memory/i,
  },
  {
    id: "openmem",
    label: "OpenMem 数据",
    paths: ["global-memory/autopilot/items.jsonl"],
    kind: "file",
    restorePattern: /restore_openmem|OPENMEM_DATA_DIR/i,
  },
  {
    id: "project",
    label: "项目记忆",
    paths: ["project-memory"],
    kind: "directory",
    restorePattern: /restore_project_memory/i,
  },
  {
    id: "logic",
    label: "逻辑链图",
    paths: ["logic-chain"],
    kind: "directory",
    restorePattern: /restore_logic_chain|逻辑链图/i,
  },
];

const FRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MANIFEST_NAMES = ["manifest.json", "MANIFEST.json", "checksums.json"];

interface ManifestFile {
  path: string;
  sha256?: string;
}

interface Manifest {
  createdAt?: string;
  files?: ManifestFile[];
  restore?: { automatic?: boolean };
  restoreDrill?: BackupDrill;
}

function reasonOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.message : "unreadable";
}

async function readManifest(snapshot: string): Promise<{
  manifest?: Manifest;
  present: boolean;
  integrity: BackupIntegrity;
  notes: string[];
}> {
  for (const name of MANIFEST_NAMES) {
    const file = path.join(snapshot, name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (reasonOf(error) === "ENOENT") continue;
      return {
        present: true,
        integrity: "unknown",
        notes: [`manifest 无法读取（${reasonOf(error)}）`],
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return {
        present: true,
        integrity: "corrupt",
        notes: ["manifest 无法解析，完整性未知"],
      };
    }
    if (!parsed || typeof parsed !== "object") {
      return {
        present: true,
        integrity: "corrupt",
        notes: ["manifest 内容无效"],
      };
    }
    return {
      present: true,
      manifest: parsed as Manifest,
      integrity: "unknown",
      notes: [],
    };
  }
  return { present: false, integrity: "unknown", notes: [] };
}

async function verifyManifest(
  snapshot: string,
  manifest: Manifest | undefined,
): Promise<{ integrity: BackupIntegrity; notes: string[] }> {
  if (!manifest) return { integrity: "unknown", notes: [] };
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const checksummed = files.filter((entry) => typeof entry.sha256 === "string");
  if (checksummed.length === 0) {
    return {
      integrity: "partial",
      notes: ["manifest 未提供校验和，仅确认结构"],
    };
  }
  for (const entry of checksummed) {
    let buffer: Buffer;
    try {
      buffer = await readFile(path.join(snapshot, entry.path));
    } catch (error) {
      return {
        integrity: "corrupt",
        notes: [`manifest 文件缺失：${entry.path}（${reasonOf(error)}）`],
      };
    }
    const actual = createHash("sha256").update(buffer).digest("hex");
    if (actual !== entry.sha256?.toLowerCase()) {
      return {
        integrity: "corrupt",
        notes: [`校验失败：${entry.path}`],
      };
    }
  }
  return { integrity: "verified", notes: [`校验通过 ${checksummed.length} 个文件`] };
}

async function inspectDomain(
  snapshot: string,
  spec: DomainSpec,
  options: {
    manifestPresent: boolean;
    manifestIntegrity: BackupIntegrity;
    checksummedPaths: Set<string>;
    freshness: BackupFreshness;
    drill?: BackupDrill;
    scriptClaim: boolean;
  },
): Promise<BackupDomainStatus> {
  const notes: string[] = [];
  const present: string[] = [];
  const missing: string[] = [];
  let state: BackupDomainState = "present";
  let corrupt = false;

  for (const relative of spec.paths) {
    const target = path.join(snapshot, relative);
    try {
      const info = await stat(target);
      if (spec.kind === "directory") {
        if (!info.isDirectory()) {
          missing.push(relative);
          state = "unknown";
          notes.push(`${relative} 不是目录`);
          continue;
        }
        const entries = await readdir(target);
        if (entries.length === 0) {
          missing.push(relative);
          state = "missing";
          notes.push(`${relative} 目录为空`);
        } else {
          present.push(relative);
        }
      } else if (!info.isFile()) {
        missing.push(relative);
        state = "unknown";
        notes.push(`${relative} 不是文件`);
      } else if (info.size === 0) {
        present.push(relative);
        corrupt = true;
        notes.push(`${relative} 为 0 字节`);
      } else {
        present.push(relative);
      }
    } catch (error) {
      if (reasonOf(error) === "ENOENT") {
        missing.push(relative);
        if (state !== "unknown") state = "missing";
      } else {
        missing.push(relative);
        state = "unknown";
        notes.push(`${relative} 无法读取（${reasonOf(error)}）`);
      }
    }
  }

  const coveredByChecksums = spec.paths.every((relative) =>
    spec.kind === "directory"
      ? [...options.checksummedPaths].some(
          (entry) => entry === relative || entry.startsWith(`${relative}/`),
        )
      : options.checksummedPaths.has(relative),
  );
  // A missing or unreadable domain cannot inherit the snapshot's integrity or
  // restore claim. Otherwise a 1/5 snapshot would show "missing / verified".
  const integrity: BackupIntegrity =
    state !== "present"
      ? "unknown"
      : corrupt
        ? "corrupt"
        : !options.manifestPresent
          ? "unknown"
          : options.manifestIntegrity === "corrupt"
            ? "corrupt"
            : coveredByChecksums
              ? "verified"
              : "partial";
  const restoreSupport: RestoreSupport =
    state !== "present"
      ? "unknown"
      : !options.drill
        ? "unknown"
        : options.drill.result !== "passed"
          ? "none"
          : options.scriptClaim
            ? "manual"
            : "none";
  return {
    id: spec.id,
    label: spec.label,
    required: [...spec.paths],
    present,
    missing,
    state,
    integrity,
    freshness: options.freshness,
    restoreSupport,
    notes,
  };
}

function createdAtFromName(name: string): string | undefined {
  const match = /^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

async function inspectSnapshot(
  dir: string,
  options: {
    now: Date;
    scriptClaims: Set<BackupDomainID>;
    root: string;
  },
): Promise<BackupSnapshot> {
  const notes: string[] = [];
  const manifestInfo = await readManifest(dir);
  notes.push(...manifestInfo.notes);
  const verification = await verifyManifest(dir, manifestInfo.manifest);
  notes.push(...verification.notes);
  const checksummedPaths = new Set(
    (manifestInfo.manifest?.files ?? [])
      .filter((entry) => typeof entry.sha256 === "string")
      .map((entry) => entry.path),
  );

  let createdAt: string | undefined;
  const manifestCreatedAt = manifestInfo.manifest?.createdAt;
  if (manifestCreatedAt && !Number.isNaN(Date.parse(manifestCreatedAt))) {
    createdAt = new Date(manifestCreatedAt).toISOString();
  } else {
    createdAt =
      createdAtFromName(path.basename(dir)) ??
      (await (async () => {
        try {
          const info = await stat(dir);
          return info.mtime.toISOString();
        } catch {
          return undefined;
        }
      })());
  }
  const freshness: BackupFreshness = createdAt
    ? options.now.getTime() - Date.parse(createdAt) > FRESH_AFTER_MS
      ? "stale"
      : "fresh"
    : "unknown";

  const name = path.basename(dir);
  const fileDrill = await readDrill(dir, options.root);
  const candidates = [
    manifestInfo.manifest?.restoreDrill,
    fileDrill.drill,
  ].filter((entry): entry is BackupDrill => entry !== undefined);
  const boundDrill = candidates.find(
    (entry) => !entry.snapshotID || entry.snapshotID === name,
  );
  if (candidates.length > 0 && !boundDrill) {
    notes.push("演练记录属于其他快照，未应用");
  }
  const drillInvalid =
    fileDrill.invalid === true || (candidates.length > 0 && !boundDrill);
  if (manifestInfo.manifest?.restore?.automatic === true) {
    notes.push("manifest 声称自动恢复，但没有可验证的自动路径；按手动/未验证处理");
  }

  const domains: BackupDomainStatus[] = [];
  for (const spec of DOMAINS) {
    domains.push(
      await inspectDomain(dir, spec, {
        manifestPresent: manifestInfo.present,
        manifestIntegrity: verification.integrity,
        checksummedPaths,
        freshness,
        drill: boundDrill,
        scriptClaim: options.scriptClaims.has(spec.id),
      }),
    );
  }

  const missing = domains
    .filter((domain) => domain.state === "missing")
    .flatMap((domain) => domain.missing);
  const unknown = domains
    .filter((domain) => domain.state === "unknown")
    .flatMap((domain) => domain.missing);
  const coverage: BackupCoverage = {
    required: DOMAINS.length,
    present: domains.filter((domain) => domain.state === "present").length,
    missing,
    unknown,
  };
  const integrity = domains.some((domain) => domain.integrity === "corrupt")
    ? "corrupt"
    : verification.integrity;
  const complete =
    coverage.present === coverage.required && integrity !== "corrupt";
  if (!manifestInfo.present) notes.push("没有 manifest，完整性未知");
  if (!complete && coverage.present > 0) notes.push("快照结构不完整");

  return {
    dir,
    name,
    createdAt,
    complete,
    integrity,
    freshness,
    manifestPresent: manifestInfo.present,
    domains,
    coverage,
    drill: boundDrill,
    drillInvalid,
    notes,
  };
}

async function readDrill(
  snapshot: string | undefined,
  root: string,
): Promise<{ drill?: BackupDrill; invalid?: boolean; notes: string[] }> {
  const candidates = [
    ...(snapshot ? [path.join(snapshot, "restore-drill.json")] : []),
    path.join(root, "restore-drill.json"),
  ];
  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (
        typeof parsed.at === "string" &&
        (parsed.result === "passed" || parsed.result === "failed")
      ) {
        return {
          drill: {
            at: parsed.at,
            result: parsed.result,
            softwareVersion:
              typeof parsed.softwareVersion === "string"
                ? parsed.softwareVersion
                : undefined,
            snapshotID:
              typeof parsed.snapshotID === "string" ? parsed.snapshotID : undefined,
          },
          notes: [],
        };
      }
      return {
        invalid: true,
        notes: [`演练记录无效：${path.basename(file)}`],
      };
    } catch {
      return {
        invalid: true,
        notes: [`演练记录无法解析：${path.basename(file)}`],
      };
    }
  }
  return { notes: [] };
}

function scriptClaims(text: string | undefined): Set<BackupDomainID> {
  const claims = new Set<BackupDomainID>();
  if (!text) return claims;
  for (const spec of DOMAINS) {
    if (spec.restorePattern.test(text)) claims.add(spec.id);
  }
  return claims;
}

export async function inspectBackup(
  root: string,
  options: {
    rollbackScript?: string;
    now?: Date;
  } = {},
): Promise<BackupStatus> {
  const now = options.now ?? new Date();
  const claims = scriptClaims(options.rollbackScript);
  const allPaths = DOMAINS.flatMap((domain) => domain.paths);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return {
      snapshotPresent: false,
      integrity: "unknown",
      freshness: "unknown",
      restoreSupport: "unknown",
      drillStatus: "invalid",
      coverage: {
        required: DOMAINS.length,
        present: 0,
        missing: [],
        unknown: allPaths,
      },
      domains: DOMAINS.map((spec) => ({
        id: spec.id,
        label: spec.label,
        required: [...spec.paths],
        present: [],
        missing: [...spec.paths],
        state: "unknown",
        integrity: "unknown",
        freshness: "unknown",
        restoreSupport: "unknown",
        notes: [`备份目录无法读取（${reasonOf(error)}）`],
      })),
      manifestPresent: false,
      notes: [`无法读取备份目录（${reasonOf(error)}）`],
    };
  }

  const names = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("backup-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const cap = 50;
  const inspected: BackupSnapshot[] = [];
  for (const name of names.slice(0, cap)) {
    inspected.push(
      await inspectSnapshot(path.join(root, name), {
        now,
        scriptClaims: claims,
        root,
      }),
    );
  }
  inspected.sort(
    (left, right) =>
      (Date.parse(right.createdAt ?? "") || 0) -
        (Date.parse(left.createdAt ?? "") || 0) ||
      right.name.localeCompare(left.name),
  );

  const latest = inspected[0];
  const latestComplete = inspected.find((snapshot) => snapshot.complete === true);
  const drill = latest?.drill;
  const drillStatus: BackupStatus["drillStatus"] = drill
    ? drill.result
    : latest?.drillInvalid
      ? "invalid"
      : "missing";
  const domains = latest?.domains ?? [];
  const support: RestoreSupport = !latest
    ? "unknown"
    : !drill
      ? "unknown"
      : domains.some((domain) => domain.restoreSupport === "manual")
        ? "manual"
        : "none";

  const notes = [...(latest?.notes ?? [])];
  if (names.length > cap) notes.push(`只检查最近 ${cap} 个快照`);
  if (latest && latest.complete !== true) {
    notes.push(
      latestComplete
        ? `最新快照结构不完整；最近结构完整快照：${latestComplete.name}`
        : "最新快照结构不完整，且没有更早的结构完整快照",
    );
  }

  return {
    latest,
    latestComplete,
    snapshotPresent: latest !== undefined,
    integrity: latest?.integrity ?? "unknown",
    freshness: latest?.freshness ?? "unknown",
    restoreSupport: support,
    restoreDrill: drill,
    drillStatus,
    coverage: latest?.coverage ?? {
      required: DOMAINS.length,
      present: 0,
      missing: allPaths,
      unknown: [],
    },
    domains:
      latest?.domains ??
      DOMAINS.map((spec) => ({
        id: spec.id,
        label: spec.label,
        required: [...spec.paths],
        present: [],
        missing: [...spec.paths],
        state: "missing",
        integrity: "unknown",
        freshness: "unknown",
        restoreSupport: "unknown",
        notes: [],
      })),
    manifestPresent: latest?.manifestPresent ?? false,
    notes,
  };
}

export const BACKUP_DOMAIN_LABELS: Record<BackupDomainID, string> = {
  l0: "L0 规则",
  l1: "OpenChamber L1",
  openmem: "OpenMem 数据",
  project: "项目记忆",
  logic: "逻辑链图",
};
