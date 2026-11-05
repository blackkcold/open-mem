import crypto from "node:crypto";

export function sha16(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Collapse whitespace and cut on a word boundary where possible. */
export function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, Math.max(0, max - 1));
  const boundary = cut.lastIndexOf(" ");
  const head = boundary > max * 0.6 ? cut.slice(0, boundary) : cut;
  return `${head}…`;
}

export function firstLine(value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function lastLines(value: string, count: number): string {
  return value.trimEnd().split("\n").slice(-Math.max(1, count)).join("\n");
}

/** Keep both ends: tool errors usually appear at the head or the tail. */
export function clipMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const half = Math.max(1, Math.floor((max - 5) / 2));
  return `${value.slice(0, half)}\n…\n${value.slice(-half)}`;
}

export function fileName(value: string | undefined): string {
  if (!value) return "";
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
}
