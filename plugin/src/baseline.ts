import { stat } from "node:fs/promises";
import path from "node:path";
import type { Item, QueueItem, Scope } from "./types.js";
import { classifyRelation, type RelationKind } from "./relations.js";
import { sha16 } from "./util/text.js";
import {
  defaultGraphRoots,
  listMarkdownFiles,
  readTextFile,
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
  line: number;
  text: string;
}

export interface BaselineIndex {
  builtAt: string;
  sources: BaselineSource[];
  sections: BaselineSection[];
  errors: string[];
}

export interface BaselineMatch {
  source: string;
  sourceId: string;
  heading: string;
  line: number;
  relation: RelationKind;
  score: number;
}

export interface BaselineStatus {
  state: "ready" | "partial" | "empty" | "unavailable";
  builtAt?: string;
  sources: number;
  sections: number;
  errors: string[];
}

interface BaselineCandidate {
  text: string;
  scope?: Scope;
  projectKey?: string;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { index: BaselineIndex; expiresAt: number }>();

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
  const errors: string[] = [];

  const addFile = async (
    file: { path: string; name: string; bytes: number; updatedAt: string },
    scope: "global" | "project",
    projectKey?: string,
  ): Promise<void> => {
    const text = await readTextFile(file.path);
    if (text === undefined) {
      errors.push(`unreadable: ${file.path}`);
      return;
    }
    const sourceId = `${scope}:${file.path}`;
    sources.push({
      id: sourceId,
      path: file.path,
      scope,
      projectKey,
      bytes: file.bytes,
      updatedAt: file.updatedAt,
    });
    sections.push(...sectionsOf(text, sourceId, file.path, scope, projectKey));
  };

  const agents = await fileInfo(path.join(roots.opencodeDir, "AGENTS.md"));
  if (agents) await addFile(agents, "global");
  for (const file of await listMarkdownFiles(path.join(roots.opencodeDir, "memory"), 1)) {
    await addFile(file, "global");
  }

  if (projectDir) {
    const projectKey = stableProjectKey(projectDir);
    const projectAgents = await fileInfo(path.join(projectDir, "AGENTS.md"));
    if (projectAgents) await addFile(projectAgents, "project", projectKey);
    const projectOpencodeAgents = await fileInfo(path.join(projectDir, ".opencode", "AGENTS.md"));
    if (projectOpencodeAgents) await addFile(projectOpencodeAgents, "project", projectKey);
    for (const file of await listMarkdownFiles(path.join(projectDir, ".memory"), 1)) {
      await addFile(file, "project", projectKey);
    }
  }

  const index: BaselineIndex = {
    builtAt: new Date().toISOString(),
    sources,
    sections,
    errors,
  };
  cache.set(key, { index, expiresAt: Date.now() + CACHE_TTL_MS });
  return index;
}

export function baselineStatus(index: BaselineIndex): BaselineStatus {
  return {
    state:
      index.sources.length === 0
        ? "unavailable"
        : index.errors.length > 0
          ? "partial"
          : index.sections.length === 0
            ? "empty"
            : "ready",
    builtAt: index.builtAt,
    sources: index.sources.length,
    sections: index.sections.length,
    errors: index.errors.slice(0, 10),
  };
}

export function matchBaseline(
  index: BaselineIndex,
  candidate: Item | QueueItem | BaselineCandidate,
  limit = 3,
): BaselineMatch[] {
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
      { text: candidate.text },
      { text: section.text },
    );
    if (relation.relation === "unknown") continue;
    matches.push({
      source: section.path,
      sourceId: section.sourceId,
      heading: section.heading || "(untitled)",
      line: section.line,
      relation: relation.relation,
      score: relation.score,
    });
  }
  return matches
    .sort((left, right) => rank(left.relation) - rank(right.relation) || right.score - left.score)
    .slice(0, limit);
}

function rank(relation: RelationKind): number {
  switch (relation) {
    case "exact":
      return 0;
    case "covered":
      return 1;
    case "conflict":
      return 2;
    case "classification-mismatch":
      return 3;
    case "partial":
      return 4;
    case "related":
      return 5;
    case "unknown":
      return 6;
  }
}

async function fileInfo(file: string): Promise<{ path: string; name: string; bytes: number; updatedAt: string } | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    return {
      path: file,
      name: path.basename(file),
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

function sectionsOf(
  text: string,
  sourceId: string,
  filePath: string,
  scope: "global" | "project",
  projectKey?: string,
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
      line: start,
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
      line: 1,
      text: text.slice(0, 20_000),
    });
  }
  return out;
}

function stableProjectKey(projectDir: string): string {
  return sha16(projectDir);
}
