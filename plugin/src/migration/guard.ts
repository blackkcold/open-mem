import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const WORKTREE_TMP = path.join(REPO_ROOT, "tmp");

export type ExitCode = 0 | 2 | 3 | 4 | 5 | 6;

export class MigrationError extends Error {
  readonly code: ExitCode;
  readonly detail?: string;
  constructor(code: ExitCode, message: string, detail?: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    if (detail) this.detail = detail;
  }
}

export interface GuardOptions {
  allowDirs?: string[];
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function sameOrAncestor(candidate: string, other: string): boolean {
  return candidate === other || isInside(other, candidate) || isInside(candidate, other);
}

async function canonicalExisting(input: string): Promise<string> {
  try {
    return await realpath(input);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new MigrationError(2, `路径不存在：${path.basename(input)}`);
    }
    throw new MigrationError(2, `无法解析路径：${path.basename(input)}`);
  }
}

async function canonicalMaybeMissing(input: string): Promise<{ resolved: string; exists: boolean }> {
  try {
    return { resolved: await realpath(input), exists: true };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new MigrationError(2, `无法解析路径：${path.basename(input)}`);
    }
    const parent = await canonicalExisting(path.dirname(path.resolve(input)));
    return { resolved: path.join(parent, path.basename(input)), exists: false };
  }
}

async function assertNoSymlinkComponents(absolute: string): Promise<void> {
  const root = path.parse(absolute).root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new MigrationError(2, `路径包含符号链接：${part}`);
      }
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new MigrationError(2, `无法检查路径：${part}`);
    }
  }
}

async function forbiddenExact(): Promise<string[]> {
  const home = path.resolve(os.homedir());
  return [path.parse(home).root, home];
}

async function forbiddenSubtrees(): Promise<string[]> {
  const opencode = path.join(path.resolve(os.homedir()), ".config", "opencode");
  const roots = [opencode];
  try { roots.push(await realpath(opencode)); } catch { /* absent is fine */ }
  return roots;
}

async function allowedRoots(options: GuardOptions): Promise<string[]> {
  const roots = [WORKTREE_TMP];
  try { roots.push(await realpath(os.tmpdir())); } catch { /* absent is fine */ }
  for (const entry of options.allowDirs ?? []) {
    roots.push(await canonicalExisting(entry));
  }
  return roots;
}

/** Resolve and validate an existing isolated data/checkpoint directory. */
export async function guardExistingDirectory(
  input: string,
  label: "data" | "checkpoint" | "target",
  options: GuardOptions = {},
): Promise<string> {
  if (!input || input.includes("\u0000")) throw new MigrationError(2, `${label} 路径无效`);
  const resolved = await canonicalExisting(input);
  await assertNoSymlinkComponents(resolved);
  const info = await lstat(resolved);
  if (!info.isDirectory()) throw new MigrationError(2, `${label} 必须是目录`);
  await assertAllowed(resolved, label, options);
  return resolved;
}

/** Resolve a new/empty target without requiring it to exist yet. */
export async function guardTargetDirectory(
  input: string,
  options: GuardOptions = {},
): Promise<{ resolved: string; exists: boolean }> {
  if (!input || input.includes("\u0000")) throw new MigrationError(2, "target 路径无效");
  const { resolved, exists } = await canonicalMaybeMissing(input);
  await assertNoSymlinkComponents(path.dirname(resolved));
  await assertAllowed(resolved, "target", options);
  if (exists) {
    await assertNoSymlinkComponents(resolved);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new MigrationError(2, "target 必须是目录");
    const entries = await readdir(resolved);
    if (entries.length > 0) throw new MigrationError(6, "target 非空；回滚只写入新的空隔离目录");
  }
  return { resolved, exists };
}

async function assertAllowed(resolved: string, label: string, options: GuardOptions): Promise<void> {
  for (const forbidden of await forbiddenExact()) {
    if (resolved === forbidden) throw new MigrationError(2, `${label} 命中禁区路径`);
  }
  for (const forbidden of await forbiddenSubtrees()) {
    if (sameOrAncestor(resolved, forbidden)) {
      throw new MigrationError(2, `${label} 命中禁区路径`);
    }
  }
  const allowed = await allowedRoots(options);
  if (!allowed.some((root) => resolved === root || isInside(resolved, root))) {
    throw new MigrationError(2, `${label} 不在允许的隔离根；请使用 worktree tmp/**、临时根或 --allow-dir`);
  }
}

export async function assertDisjoint(dataDir: string, checkpointRoot: string): Promise<void> {
  if (sameOrAncestor(dataDir, checkpointRoot)) {
    throw new MigrationError(2, "data 与 checkpoint 不得相同或互为祖先");
  }
}

export async function guardCheckpointRoot(
  input: string,
  options: GuardOptions = {},
): Promise<string> {
  const { resolved, exists } = await canonicalMaybeMissing(input);
  await assertNoSymlinkComponents(path.dirname(resolved));
  await assertAllowed(resolved, "checkpoint", options);
  if (exists) {
    await assertNoSymlinkComponents(resolved);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new MigrationError(2, "checkpoint 必须是目录");
  }
  return resolved;
}

export async function ensureCheckpointRoot(
  input: string,
  options: GuardOptions = {},
): Promise<string> {
  const { resolved, exists } = await canonicalMaybeMissing(input);
  await assertNoSymlinkComponents(path.dirname(resolved));
  await assertAllowed(resolved, "checkpoint", options);
  if (exists) {
    await assertNoSymlinkComponents(resolved);
    const info = await lstat(resolved);
    if (!info.isDirectory()) throw new MigrationError(2, "checkpoint 必须是目录");
  } else {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
  }
  return resolved;
}

/** Reject absolute/.. /NUL manifest paths and ensure they stay under the root. */
export function manifestRelative(relative: string): string {
  if (!relative || relative.includes("\u0000") || path.isAbsolute(relative) ||
      /^[A-Za-z]:[\\/]/u.test(relative) || relative.startsWith("~") ||
      relative.split(/[\\/]+/u).some((part) => part === "..")) {
    throw new MigrationError(5, "checkpoint manifest 含非法相对路径");
  }
  const normalized = path.normalize(relative);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) ||
      normalized.split(/[\\/]+/u).some((part) => part === "..") || normalized.includes("\u0000")) {
    throw new MigrationError(5, "checkpoint manifest 含越界路径");
  }
  return normalized;
}

export async function assertRegularFile(file: string): Promise<"file" | "absent"> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new MigrationError(5, "checkpoint 含非普通文件或链接");
    return "file";
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "absent";
    throw new MigrationError(5, "无法检查 checkpoint 文件");
  }
}
