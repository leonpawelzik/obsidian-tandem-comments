/**
 * Optional keystroke/persist counters for longform diagnosis.
 * Off by default — zero cost when debugPerf is false.
 */

export interface PerfSnapshot {
  parses: number;
  updates: number;
  lastUpdateMs: number;
  lastPersistMs: number;
  lastTableMs: number;
  sidebarRenders: number;
  sidebarSkips: number;
  decorationRebuilds: number;
  decorationMaps: number;
}

const empty = (): PerfSnapshot => ({
  parses: 0,
  updates: 0,
  lastUpdateMs: 0,
  lastPersistMs: 0,
  lastTableMs: 0,
  sidebarRenders: 0,
  sidebarSkips: 0,
  decorationRebuilds: 0,
  decorationMaps: 0,
});

let enabled = false;
let stats = empty();

/** Soft budgets (ms) — exceeded values log when debug is on. */
export const PERF_BUDGET_UPDATE_MS = 2;
export const PERF_BUDGET_PERSIST_MS = 16;
export const PERF_BUDGET_TABLE_MS = 8;

export function setPerfEnabled(on: boolean): void {
  enabled = on;
  if (!on) stats = empty();
}

export function isPerfEnabled(): boolean {
  return enabled;
}

export function resetPerf(): void {
  stats = empty();
}

export function getPerfSnapshot(): PerfSnapshot {
  return { ...stats };
}

export function recordParse(): void {
  if (enabled) stats.parses++;
}

export function recordUpdate(ms: number): void {
  if (!enabled) return;
  stats.updates++;
  stats.lastUpdateMs = ms;
  if (ms > PERF_BUDGET_UPDATE_MS) {
    console.debug(`[tandem-perf] update ${ms.toFixed(2)}ms (budget ${PERF_BUDGET_UPDATE_MS})`);
  }
}

export function recordPersist(ms: number): void {
  if (!enabled) return;
  stats.lastPersistMs = ms;
  if (ms > PERF_BUDGET_PERSIST_MS) {
    console.debug(`[tandem-perf] persist ${ms.toFixed(2)}ms (budget ${PERF_BUDGET_PERSIST_MS})`);
  }
}

export function recordTable(ms: number): void {
  if (!enabled) return;
  stats.lastTableMs = ms;
  if (ms > PERF_BUDGET_TABLE_MS) {
    console.debug(`[tandem-perf] table ${ms.toFixed(2)}ms (budget ${PERF_BUDGET_TABLE_MS})`);
  }
}

export function recordSidebarRender(): void {
  if (enabled) stats.sidebarRenders++;
}

export function recordSidebarSkip(): void {
  if (enabled) stats.sidebarSkips++;
}

export function recordDecorationRebuild(): void {
  if (enabled) stats.decorationRebuilds++;
}

export function recordDecorationMap(): void {
  if (enabled) stats.decorationMaps++;
}

/** One-line summary for Notice / console. */
export function formatPerfSnapshot(s: PerfSnapshot = getPerfSnapshot()): string {
  return [
    `updates=${s.updates}`,
    `parses=${s.parses}`,
    `updMs=${s.lastUpdateMs.toFixed(1)}`,
    `persistMs=${s.lastPersistMs.toFixed(1)}`,
    `tableMs=${s.lastTableMs.toFixed(1)}`,
    `sidebar=${s.sidebarRenders}/${s.sidebarSkips} (render/skip)`,
    `deco=${s.decorationMaps}/${s.decorationRebuilds} (map/rebuild)`,
  ].join(" ");
}
