import type { ItemKind, Scope } from "../types.js";

export interface RewriteInput {
  candidate: { id?: string; title: string; text: string; kind: ItemKind; scope: Scope };
  target: { id: string; title: string; text: string; kind: ItemKind; scope: Scope };
  action: "merge_into" | "replace";
  maxChars: number;
  titleMaxChars: number;
  conflict: number;
}

export interface RewriteOutput {
  action: "merge" | "replace" | "keep_both";
  title: string;
  text: string;
  preserved: string[];
  dropped: Array<{ text: string; reason: string }>;
  rationale: string;
  source: "systemtwo" | "composer";
  model?: { providerID: string; id: string; variant?: string };
  usage?: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  raw?: string;
}

export interface RewriteValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
