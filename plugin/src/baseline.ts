import path from "node:path";
import type { Item, QueueItem, Scope } from "./types.js";
import { classifyRelation, type RelationKind } from "./relations.js";
import { sha16 } from "./util/text.js";
import {
  BASELINE_MAX_FILES,
  BASELINE_MAX_READ_BYTES,
  defaultGraphRoots,
  readTextFileDetailed,
  scanMarkdownFiles,
  type GraphRoots,
} from "./graph.js";

export interface BaselineSource {
  id: string;
  path: string;
  scope: "global" | "project";
  projectKey?: string;
  bytes?: number;
  updatedAt?: string;
}

export interface BaselineSection {
  sourceId: string;
  path: string;
  scope: "global" | "project";
  projectKey?: string;
  heading: string;
  /** Optional kind parsed from a file-level frontmatter block. */
  kind?: Item["kind"];
  line: number;
  text: string;
}

export interface BaselineError {
  path: string;
  reason: string;
}

export interface BaselineIndex {
  builtAt: string;
  configured: boolean;
  sources: BaselineSource[];
  sections: BaselineSection[];
  errors: BaselineError[];
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  truncatedFiles: number;
  maxFiles: number;
  maxReadBytes: number;
  limitReached: boolean;
  projectKey?: string;
}

export interface BaselineMatch {
  source: string;
  sourceId: string;
  heading: string;
  line: number;
  relation: RelationKind;
  score: number;
  reasons: string[];
}

export type CoverageRelation =
  | "conflict"
  | "classification-mismatch"
  | "covered"
  | "partial"
  | "related"
  | "unknown";

export interface BaselineCoverageSummary {
  /** Highest-priority relation across every match, not just the first page. */
  relation: CoverageRelation;
  conflictCount: number;
  mismatchCount: number;
  /** `exact` counts as covered here; it is still not allowed to mask a conflict. */
  coveredCount: number;
  total: number;
  /**
   * Content-derived analysis identity. Deliberately excludes builtAt: the
   * 30-second cache would otherwise make the version flap without a change.
   */
  analysisVersion: string;
}

export interface BaselineAnalysis {
  /** Every match, unsliced: the summary must never be computed after a limit. */
  matches: BaselineMatch[];
  summary: BaselineCoverageSummary;
}

export interface BaselineStatus {
  state: "unconfigured" | "empty" | "partial" | "stale" | "ready" | "error";
  builtAt?: string;
  analysisVersion: string;
  sources: number;
  sections: number;
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  truncatedFiles: number;
  errors: BaselineError[];
  projectKey?: string;
  projectCoverageState: string;
  maxFiles: number;
  maxReadBytes: number;
}

interface BaselineCandidate {
  text: string;
  title?: string;
  kind?: Item["kind"];
  scope?: Scope;
  projectKey?: string;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { index: BaselineIndex; expiresAt: number }>();
const analysisVersionCache = new WeakMap<BaselineIndex, string>();

export async function buildBaselineIndex(options: {
  projectDir?: string;
  roots?: Partial<GraphRoots>;
  force?: boolean;
}): Promise<BaselineIndex> {
  const roots = { ...defaultGraphRoots(options.projectDir), ...options.roots };
  const projectDir = roots.projectDir ?? options.projectDir;
  const key = `${roots.opencodeDir}|${projectDir ?? ""}`;
  const cached = cache.get(key);
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return cached.index;
  }

  const sources: BaselineSource[] = [];
  const sections: BaselineSection[] = [];
  const errors: BaselineError[] = [];
  const maxFiles = BASELINE_MAX_FILES;
  const maxReadBytes = BASELINE_MAX_READ_BYTES;
  let filesSeen = 0;
  let truncatedFiles = 0;
  let limitReached = false;

  const ingest = async (
    file: { path: string; bytes?: number; updatedAt?: string },
    scope: "global" | "project",
    projectKey: string | undefined,
    counted: boolean,
  ): Promise<void> => {
    if (!counted && filesSeen >= maxFiles) {
      filesSeen += 1;
      limitReached = true;
      return;
    }
    const read = await readTextFileDetailed(file.path, maxReadBytes);
    if (read.error === "ENOENT") return;
    if (!counted) filesSeen += 1;
    if (read.error || read.text === undefined) {
      errors.push({ path: file.path, reason: read.error ?? "unreadable" });
      return;
    }
    if (read.truncated) truncatedFiles += 1;
    const sourceId = `${scope}:${file.path}`;
    const { body, kind, lineOffset } = splitFrontmatter(read.text);
    sources.push({
      id: sourceId,
      path: file.path,
      scope,
      projectKey,
      bytes: read.bytes || file.bytes,
      updatedAt: read.updatedAt ?? file.updatedAt,
    });
    sections.push(...sectionsOf(body, sourceId, file.path, scope, projectKey, kind, lineOffset));
  };

  const ingestScan = async (
    dir: string,
    scope: "global" | "project",
    projectKey?: string,
  ): Promise<void> => {
    const scan = await scanMarkdownFiles(
      dir,
      1,
      Math.max(0, maxFiles - filesSeen),
    );
    filesSeen += scan.seen;
    limitReached = limitReached || scan.limitReached;
    errors.push(...scan.errors);
    for (const file of scan.files) {
      await ingest(file, scope, projectKey, true);
    }
  };

  await ingest(
    { path: path.join(roots.opencodeDir, "AGENTS.md") },
    "global",
    undefined,
    false,
  );
  await ingestScan(path.join(roots.opencodeDir, "memory"), "global");

  const projectKey = projectDir ? stableProjectKey(projectDir) : undefined;
  if (projectDir) {
    await ingest(
      { path: path.join(projectDir, "AGENTS.md") },
      "project",
      projectKey,
      false,
    );
    await ingest(
      { path: path.join(projectDir, ".opencode", "AGENTS.md") },
      "project",
      projectKey,
      false,
    );
    await ingestScan(path.join(projectDir, ".memory"), "project", projectKey);
  }

  const index: BaselineIndex = {
    builtAt: new Date().toISOString(),
    configured: Boolean(roots.opencodeDir),
    sources,
    sections,
    errors,
    filesSeen,
    filesIndexed: sources.length,
    filesSkipped: Math.max(0, filesSeen - sources.length),
    truncatedFiles,
    maxFiles,
    maxReadBytes,
    limitReached,
    projectKey,
  };
  cache.set(key, { index, expiresAt: Date.now() + CACHE_TTL_MS });
  return index;
}

const STALE_AFTER_MS = 15 * 60 * 1000;

function stateOf(index: BaselineIndex): BaselineStatus["state"] {
  if (!index.configured) return "unconfigured";
  if (Date.now() - Date.parse(index.builtAt) > STALE_AFTER_MS) return "stale";
  if (index.filesSeen === 0) {
    return index.errors.length > 0 ? "error" : "empty";
  }
  if (index.filesIndexed === 0) return "error";
  if (
    index.errors.length > 0 ||
    index.truncatedFiles > 0 ||
    index.filesSkipped > 0 ||
    index.limitReached
  ) {
    return "partial";
  }
  if (index.sections.length === 0) return "empty";
  return "ready";
}

function projectCoverageState(
  index: BaselineIndex,
  state: BaselineStatus["state"],
): string {
  if (!index.projectKey) return "not-configured";
  if (!index.sources.some((source) => source.scope === "project")) return "empty";
  return state === "ready" ? "ready" : state;
}

export function baselineStatus(index: BaselineIndex): BaselineStatus {
  const state = stateOf(index);
  return {
    state,
    builtAt: index.builtAt,
    analysisVersion: analysisVersionOf(index),
    sources: index.sources.length,
    sections: index.sections.length,
    filesSeen: index.filesSeen,
    filesIndexed: index.filesIndexed,
    filesSkipped: index.filesSkipped,
    truncatedFiles: index.truncatedFiles,
    errors: index.errors.slice(0, 10),
    projectKey: index.projectKey,
    projectCoverageState: projectCoverageState(index, state),
    maxFiles: index.maxFiles,
    maxReadBytes: index.maxReadBytes,
  };
}

/**
 * Collect every match, then summarize. The previous order (slice, then let the
 * caller read `coverage[0]`) let three covered hits hide a conflict entirely.
 */
export function analyzeBaselineCoverage(
  index: BaselineIndex,
  candidate: Item | QueueItem | BaselineCandidate,
): BaselineAnalysis {
  const scope = candidate.scope;
  const projectKey = candidate.projectKey;
  const matches: BaselineMatch[] = [];
  for (const section of index.sections) {
    if (
      section.scope === "project" &&
      !(scope === "project" && projectKey !== undefined && projectKey === section.projectKey)
    ) {
      continue;
    }
    const relation = classifyRelation(
      {
        text: candidate.text,
        title: (candidate as { title?: string }).title,
        kind: (candidate as { kind?: Item["kind"] }).kind,
      },
      {
        text: section.text,
        title: section.heading || undefined,
        kind: section.kind,
      },
    );
    if (relation.relation === "unknown") continue;
    matches.push({
      source: section.path,
      sourceId: section.sourceId,
      heading: section.heading || "(untitled)",
      line: section.line,
      relation: relation.relation,
      score: relation.score,
      reasons: relation.reasons,
    });
  }
  matches.sort(
    (left, right) =>
      rank(left.relation) - rank(right.relation) || right.score - left.score,
  );
  return { matches, summary: summarizeCoverage(index, matches) };
}

export function matchBaseline(
  index: BaselineIndex,
  candidate: Item | QueueItem | BaselineCandidate,
  limit = 3,
): BaselineMatch[] {
  return analyzeBaselineCoverage(index, candidate).matches.slice(0, limit);
}

function summarizeCoverage(
  index: BaselineIndex,
  matches: BaselineMatch[],
): BaselineCoverageSummary {
  const conflictCount = matches.filter((match) => match.relation === "conflict").length;
  const mismatchCount = matches.filter(
    (match) => match.relation === "classification-mismatch",
  ).length;
  const coveredCount = matches.filter(
    (match) => match.relation === "exact" || match.relation === "covered",
  ).length;
  const best = matches.reduce<RelationKind>(
    (current, match) => (rank(match.relation) < rank(current) ? match.relation : current),
    "unknown",
  );
  return {
    relation: best === "exact" ? "covered" : best,
    conflictCount,
    mismatchCount,
    coveredCount,
    total: matches.length,
    analysisVersion: analysisVersionOf(index),
  };
}

function analysisVersionOf(index: BaselineIndex): string {
  const cached = analysisVersionCache.get(index);
  if (cached) return cached;
  const sources = index.sources
    .map((source) => [source.id, source.bytes ?? 0, source.updatedAt ?? ""].join(":"))
    .sort()
    .join("\n");
  const sections = index.sections
    .map((section) =>
      [
        section.sourceId,
        section.line,
        sha16(section.heading),
        sha16(section.text),
      ].join(":"),
    )
    .sort()
    .join("\n");
  const value = sha16(`${sources}\n--\n${sections}`);
  analysisVersionCache.set(index, value);
  return value;
}

function rank(relation: RelationKind): number {
  switch (relation) {
    case "conflict":
      return 0;
    case "classification-mismatch":
      return 1;
    case "covered":
      return 2;
    case "exact":
      return 3;
    case "partial":
      return 4;
    case "related":
      return 5;
    case "unknown":
      return 6;
  }
}

function sectionsOf(
  text: string,
  sourceId: string,
  filePath: string,
  scope: "global" | "project",
  projectKey?: string,
  kind?: Item["kind"],
  lineOffset = 0,
): BaselineSection[] {
  const lines = text.split("\n");
  const out: BaselineSection[] = [];
  let heading = "";
  let start = 1;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join("\n").trim();
    if (body.length === 0) return;
    out.push({
      sourceId,
      path: filePath,
      scope,
      projectKey,
      heading,
      kind,
      line: start + lineOffset,
      text: body,
    });
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[2].trim();
      start = index + 1;
      buffer = [];
      continue;
    }
    buffer.push(line);
    if (buffer.length >= 160) {
      flush();
      buffer = [];
      start = index + 2;
    }
  }
  flush();
  if (out.length === 0) {
    out.push({
      sourceId,
      path: filePath,
      scope,
      projectKey,
      heading: "",
      kind,
      line: 1 + lineOffset,
      text: text.slice(0, 20_000),
    });
  }
  return out;
}

const ITEM_KINDS: Item["kind"][] = ["fact", "preference", "rule", "reference", "skill"];

/**
 * A file may declare one kind for all of its sections. There is no per-section
 * convention today, so an absent block leaves the kind unknown instead of
 * guessing from the heading.
 */
function splitFrontmatter(text: string): {
  body: string;
  kind?: Item["kind"];
  lineOffset: number;
} {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!block) return { body: text, lineOffset: 0 };
  const value = /^kind:\s*([a-z-]+)\s*$/im.exec(block[1])?.[1]?.toLowerCase();
  return {
    body: text.slice(block[0].length),
    kind: value && (ITEM_KINDS as string[]).includes(value) ? (value as Item["kind"]) : undefined,
    lineOffset: block[0].split("\n").length - 1,
  };
}

function stableProjectKey(projectDir: string): string {
  return sha16(projectDir);
}
