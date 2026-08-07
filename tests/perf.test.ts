import { afterEach, describe, expect, it } from "vitest";
import {
  formatPerfSnapshot,
  getPerfSnapshot,
  isPerfEnabled,
  recordDecorationMap,
  recordSidebarSkip,
  recordUpdate,
  resetPerf,
  setPerfEnabled,
} from "../src/perf";

describe("perf counters", () => {
  afterEach(() => {
    setPerfEnabled(false);
    resetPerf();
  });

  it("does not count when disabled", () => {
    setPerfEnabled(false);
    recordUpdate(5);
    recordDecorationMap();
    expect(getPerfSnapshot().updates).toBe(0);
    expect(getPerfSnapshot().decorationMaps).toBe(0);
  });

  it("counts when enabled and formats a snapshot", () => {
    setPerfEnabled(true);
    resetPerf();
    recordUpdate(1.5);
    recordDecorationMap();
    recordSidebarSkip();
    const s = getPerfSnapshot();
    expect(isPerfEnabled()).toBe(true);
    expect(s.updates).toBe(1);
    expect(s.lastUpdateMs).toBe(1.5);
    expect(s.decorationMaps).toBe(1);
    expect(s.sidebarSkips).toBe(1);
    expect(formatPerfSnapshot(s)).toContain("updates=1");
    expect(formatPerfSnapshot(s)).toContain("sidebar=");
  });
});
