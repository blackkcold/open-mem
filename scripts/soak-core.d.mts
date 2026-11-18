/**
 * Types for `scripts/soak-core.mjs`, used by the soak test so it can be
 * typechecked under strict mode without `any`.
 */
export interface SoakInvariant {
  id: string;
  title: string;
  ok: boolean;
  partial: boolean;
  evidence: Record<string, unknown>;
}

export interface SoakFailure {
  id: string;
  detail: string;
}

export interface SoakTotals {
  consolidationCalls: number;
  writes: number;
  stops: number;
  restores: number;
  reverts: number;
  restoreVersions: number;
  correctionsQueued: number;
  blockedRelearn: number;
  duplicateAttempts: number;
  duplicateSkips: number;
  shadowed: number;
}

export interface SoakRetentionCounts {
  changes: number;
  changeJournals: number;
  suppressions: number;
  quarantine: number;
  retiredSources: number;
  globalCandidates: number;
  migrationJournals: number;
  checkpointBackups: number;
}

export interface SoakCapacitySample {
  day: number;
  ratio: number;
  level: string;
  diskBytes: number;
}

export interface SoakModes {
  shadow: string;
  autonomous: string;
}

export interface SoakShadowEvidence {
  shadowed: number;
  auto: number;
  itemsBefore: number;
  itemsAfter: number;
  shadowBefore: number;
  shadowAfter: number;
}

export interface SoakReport {
  simulated: boolean;
  fakeClock: boolean;
  formatVersion: number;
  toolVersion: string;
  seed: number;
  days: number;
  sessions: number;
  startedAt: string;
  finishedAt: string;
  productionModules: string[];
  invariants: SoakInvariant[];
  failures: SoakFailure[];
  ok: boolean;
  modes: SoakModes;
  shadow: SoakShadowEvidence;
  budget: { consumedInSoak: number };
  totals: SoakTotals;
  retentionCounts: SoakRetentionCounts;
  capacityMax: SoakCapacitySample;
  capacitySamples: SoakCapacitySample[];
  notes: string[];
}

export interface SoakOptions {
  days?: number;
  sessions?: number;
  seed?: number;
  dataDir: string;
  checkpointRoot?: string;
  startAt?: number;
  config?: unknown;
  setNow?: (now: number) => void;
  errors?: string[];
}

export function runSoak(options: SoakOptions): Promise<SoakReport>;
export function assertSafeSoakPath(target: string, label?: string): Promise<string>;

export const SOAK_FORMAT_VERSION: number;
export const SOAK_TOOL_VERSION: string;
export const DAY: number;
export const DEFAULT_START_AT: number;
export const PRODUCTION_MODULES: readonly string[];
export const SOAK_TEXTS: Readonly<{
  factA: string;
  factB: string;
  factC: string;
  shadowFact: string;
  correctionA: string;
  rule: string;
  skill: string;
  sessionNote: string;
}>;
export const SOAK_INVARIANTS: ReadonlyArray<{ id: string; title: string }>;
