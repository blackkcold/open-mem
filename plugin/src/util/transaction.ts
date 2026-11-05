import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type FileBatch = Map<string, string | null>;
const WAL = ".pending-transaction.json";

/** Reject both lexical escapes and symlink traversal inside a private store. */
export async function safeStorePath(root: string, file: string): Promise<string> {
  const base = path.resolve(root);
  const full = path.resolve(file);
  const relative = path.relative(base, full);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("unsafe transaction path");
  let cursor = base;
  for (const part of ["", ...relative.split(path.sep)]) {
    if (part) cursor = path.join(cursor, part);
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("symlink in store transaction path");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return full;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableReplace(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, "wx", 0o600);
  try { await handle.writeFile(text, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, file);
  await syncDirectory(path.dirname(file));
}

interface Operation { file: string; text: string | null }
interface Journal { version: 1; operations: Operation[] }

async function replay(root: string, journal: Journal): Promise<void> {
  // Validate every destination before changing any file.
  for (const operation of journal.operations) {
    if (operation.file === WAL) throw new Error("recursive transaction journal");
    await safeStorePath(root, path.join(root, operation.file));
  }
  for (const operation of journal.operations) {
    const file = await safeStorePath(root, path.join(root, operation.file));
    if (operation.text === null) {
      await fs.unlink(file).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
      await syncDirectory(path.dirname(file));
    } else await durableReplace(file, operation.text);
  }
  await fs.unlink(path.join(root, WAL));
  await syncDirectory(root);
}

/** Must be called with the store file lock held, before any newer mutation. */
export async function recoverFileBatch(root: string): Promise<void> {
  let raw: string;
  try { raw = await fs.readFile(await safeStorePath(root, path.join(root, WAL)), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("operations" in value) || !Array.isArray(value.operations)) throw new Error("invalid transaction journal; original preserved");
  const operations: Operation[] = [];
  for (const row of value.operations) {
    if (!row || typeof row !== "object" || typeof row.file !== "string" ||
        !(row.text === null || typeof row.text === "string")) throw new Error("invalid transaction operation");
    operations.push({ file: row.file, text: row.text });
  }
  await replay(root, { version: 1, operations });
}

export async function commitFileBatch(root: string, batch: FileBatch): Promise<void> {
  if (!batch.size) return;
  if (batch.size === 1) {
    const first = batch.entries().next().value;
    if (first && first[1] !== null) {
      await durableReplace(await safeStorePath(root, first[0]), first[1]);
      return;
    }
  }
  const operations: Operation[] = [];
  for (const [file, text] of batch) {
    const full = await safeStorePath(root, file);
    const relative = path.relative(path.resolve(root), full);
    if (relative === WAL) throw new Error("reserved transaction path");
    operations.push({ file: relative, text });
  }
  const journal: Journal = { version: 1, operations };
  await durableReplace(await safeStorePath(root, path.join(root, WAL)), `${JSON.stringify(journal)}\n`);
  await replay(root, journal);
}
