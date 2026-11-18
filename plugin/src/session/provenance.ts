import path from "node:path";

/**
 * Native session identity as exposed by the host. Only these host fields may
 * prove ownership; context project keys and old review records are hints and
 * must never be fed back in as evidence.
 */
export interface NativeSessionIdentity {
  id?: string;
  /** Set only when the host carried an actual parent slot (id or null). */
  parentKnown: boolean;
  parentID?: string;
  agent?: string;
  /** Native directory/project roots, in payload order. */
  directories: string[];
}

export interface OwnerLocation {
  directory?: string;
  canonical?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function addDirectory(out: string[], value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    out.push(value);
  }
}

function readLocation(out: string[], value: unknown): void {
  if (!isRecord(value)) return;
  addDirectory(out, value.directory);
  if (isRecord(value.project)) addDirectory(out, value.project.canonical);
}

function readParent(
  value: Record<string, unknown>,
): { known: boolean; id?: string } {
  for (const key of ["parentID", "parent_id"] as const) {
    if (!(key in value)) continue;
    const parent = value[key];
    // A missing optional key is not root proof. An explicit null is.
    if (typeof parent === "string" && parent.length > 0) {
      return { known: true, id: parent };
    }
    if (parent === null) return { known: true };
  }
  return { known: false };
}

/**
 * Read `session.created.data`, `session.get`/Session.Info, or a legacy
 * `{info}` envelope. Unknown shapes return undefined instead of guessing.
 */
export function readNativeSessionIdentity(value: unknown): NativeSessionIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const outer = value;
  // Some host clients wrap session.get in `{ data: Session.Info }`.
  if (
    !isRecord(outer.info) &&
    isRecord(outer.data) &&
    (typeof outer.data.id === "string" ||
      typeof outer.data.sessionID === "string" ||
      isRecord(outer.data.location))
  ) {
    return readNativeSessionIdentity(outer.data);
  }
  const info = isRecord(outer.info) ? outer.info : outer;
  const id =
    typeof info.id === "string"
      ? info.id
      : typeof info.sessionID === "string"
        ? info.sessionID
        : typeof outer.id === "string"
          ? outer.id
          : typeof outer.sessionID === "string"
            ? outer.sessionID
            : undefined;
  const directories: string[] = [];
  readLocation(directories, info.location);
  addDirectory(directories, info.directory);
  if (info !== outer) {
    readLocation(directories, outer.location);
    addDirectory(directories, outer.directory);
  }
  if (isRecord(info.project)) addDirectory(directories, info.project.canonical);
  if (isRecord(outer.project)) addDirectory(directories, outer.project.canonical);

  const parent = readParent(info);
  const outerParent = info === outer ? { known: false } : readParent(outer);
  const agent =
    typeof info.agent === "string"
      ? info.agent
      : typeof outer.agent === "string"
        ? outer.agent
        : undefined;

  if (id === undefined && directories.length === 0 && !parent.known && !outerParent.known) {
    return undefined;
  }
  return {
    ...(id !== undefined ? { id } : {}),
    parentKnown: parent.known || outerParent.known,
    ...((parent.id ?? outerParent.id)
      ? { parentID: parent.id ?? outerParent.id }
      : {}),
    ...(agent !== undefined ? { agent } : {}),
    directories: uniqueDirectories(directories),
  };
}

function uniqueDirectories(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = comparablePath(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  const trimmed = resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
  // Matching only: macOS/Windows paths are case-insensitive; the stored
  // projectKey still uses the host's original string.
  return process.platform === "darwin" || process.platform === "win32"
    ? trimmed.toLowerCase()
    : trimmed;
}

export function directoryBelongsTo(directory: string, owner: OwnerLocation): boolean {
  const candidate = comparablePath(directory);
  for (const root of [owner.canonical, owner.directory]) {
    if (!root) continue;
    const normalized = comparablePath(root);
    if (candidate === normalized || candidate.startsWith(`${normalized}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

/**
 * All native evidence must agree. One foreign root makes the session foreign,
 * so a contradictory event/state pair fails closed instead of picking a side.
 */
export function classifySessionDirectories(
  directories: string[],
  owner: OwnerLocation,
): "owned" | "foreign" | "unknown" {
  if (directories.length === 0) return "unknown";
  let owned = false;
  for (const directory of directories) {
    if (!directoryBelongsTo(directory, owner)) return "foreign";
    owned = true;
  }
  return owned ? "owned" : "unknown";
}
