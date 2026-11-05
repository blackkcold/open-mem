import { randomBytes } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";

export class StoreLockTimeout extends Error {
  constructor(readonly path: string) {
    super(`timed out waiting for store lock: ${path}`);
    this.name = "StoreLockTimeout";
  }
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One lock file per dataDir. This is intentionally not re-entrant: callers
 * must wrap a single read-modify-write, never a transaction that calls another
 * locking Store method.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 30_000;
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;
  let delay = 5;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          token,
          at: Date.now(),
        }),
        "utf8",
      );
      await handle.close();
      break;
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => undefined);
      let live = false;
      let dead = false;
      let inspected = "";
        try {
          inspected = await readFile(lockPath, "utf8");
          const owner = JSON.parse(inspected) as { pid?: number; host?: string };
          if (owner.host === os.hostname() && Number.isInteger(owner.pid) && (owner.pid ?? 0) > 0) {
            try {
              process.kill(owner.pid!, 0);
              live = true;
            } catch (error) {
              live = error instanceof Error && "code" in error && error.code === "EPERM";
              dead = error instanceof Error && "code" in error && error.code === "ESRCH";
            }
          }
        } catch {
          // Malformed abandoned locks can still be recovered after the TTL.
        }
      if (info && (dead || Date.now() - info.mtimeMs > staleMs)) {
        if (Date.now() >= deadline) throw new StoreLockTimeout(lockPath);
        if (live) {
          await sleep(delay);
          delay = Math.min(50, delay * 2);
          continue;
        }
        // Rename first so two breakers cannot both claim the same stale inode.
        const stalePath = `${lockPath}.stale-${token}`;
        try {
          // Recheck the observed owner; a replacement must not be reaped.
          if (await readFile(lockPath, "utf8") !== inspected) continue;
          await rename(lockPath, stalePath);
          await unlink(stalePath).catch(() => undefined);
        } catch {
          // Another breaker won; retry the normal acquisition.
        }
        continue;
      }
      if (Date.now() >= deadline) throw new StoreLockTimeout(lockPath);
      await sleep(delay);
      delay = Math.min(50, delay * 2);
    }
  }

  try {
    return await fn();
  } finally {
    const raw = await readFile(lockPath, "utf8").catch(() => undefined);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { token?: string };
        if (parsed.token === token) await unlink(lockPath);
      } catch {
        // Corrupt lock file: leave it to the stale TTL path.
      }
    }
  }
}
