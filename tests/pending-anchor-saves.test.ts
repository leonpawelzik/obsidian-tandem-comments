import { describe, expect, it } from "vitest";
import { PendingAnchorSaves } from "../src/pending-anchor-saves";

function harness(raw: string) {
  const file = {};
  const disk = { raw, writes: 0 };
  const saves = new PendingAnchorSaves<object>(async (_file, update) => {
    const next = update(disk.raw);
    if (next !== disk.raw) { disk.writes++; disk.raw = next; await saves.modified(file); }
  });
  return { file, disk, saves };
}

describe("closed editor anchor saves", () => {
  it("repairs an already persisted snapshot once", async () => {
    const h = harness("edited");
    await h.saves.queue(h.file, "edited", "repaired");
    expect(h.disk).toEqual({ raw: "repaired", writes: 1 });
  });
  it("waits for the editor autosave when disk still has the old snapshot", async () => {
    const h = harness("old");
    await h.saves.queue(h.file, "edited", "repaired");
    expect(h.disk.raw).toBe("old");
    h.disk.raw = "edited"; await h.saves.modified(h.file);
    expect(h.disk.raw).toBe("repaired");
  });
  it("does not overwrite newer external content and drops the stale repair", async () => {
    const h = harness("old"); await h.saves.queue(h.file, "edited", "repaired");
    h.disk.raw = "external"; await h.saves.modified(h.file);
    h.disk.raw = "edited"; await h.saves.modified(h.file);
    expect(h.disk.writes).toBe(0);
  });
  it("forgets deleted files", async () => {
    const h = harness("old"); await h.saves.queue(h.file, "edited", "repaired");
    h.saves.forget(h.file); h.disk.raw = "edited"; await h.saves.modified(h.file);
    expect(h.disk.writes).toBe(0);
  });
  it("keeps saves isolated by file object", async () => {
    const a = {}, b = {}, data = new Map([[a, "old"], [b, "edited"]]);
    const saves = new PendingAnchorSaves<object>(async (file, update) => { data.set(file, update(data.get(file)!)); });
    await saves.queue(a, "edited", "repaired"); await saves.modified(b);
    expect(data.get(b)).toBe("edited");
    data.set(a, "edited"); await saves.modified(a); expect(data.get(a)).toBe("repaired");
  });
  it("uses the newest queued snapshot when two editors close before a save starts", async () => {
    const h = harness("newest");
    const first = h.saves.queue(h.file, "older", "older repair");
    const second = h.saves.queue(h.file, "newest", "newest repair");
    await Promise.all([first, second]);
    expect(h.disk).toEqual({ raw: "newest repair", writes: 1 });
  });
  it("invalidates a queued repair when the plugin unloads", async () => {
    const h = harness("edited");
    const pending = h.saves.queue(h.file, "edited", "repaired");
    h.saves.clear(); await pending;
    expect(h.disk.writes).toBe(0);
  });
  it("rechecks a modify event received during an asynchronous process", async () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const file = {}, disk = { raw: "old" };
    let calls = 0;
    const saves = new PendingAnchorSaves<object>(async (_file, update) => {
      calls++;
      if (calls === 1) await gate;
      disk.raw = update(disk.raw);
    });
    const queued = saves.queue(file, "edited", "repaired");
    await Promise.resolve();
    disk.raw = "edited"; const modified = saves.modified(file);
    release(); await Promise.all([queued, modified]);
    expect(disk.raw).toBe("repaired");
  });

  it.each([0, 1, 2, 3, 4])("does not drop a save queued %i microtasks after a write", async (hops) => {
    const file = {}, disk = { raw: "first" };
    let enqueue!: Promise<void>, second!: Promise<void>;
    const saves = new PendingAnchorSaves<object>(async (_file, update) => {
      disk.raw = update(disk.raw);
      if (disk.raw === "first repair") {
        enqueue = Promise.resolve();
        for (let i = 0; i < hops; i++) enqueue = enqueue.then(() => {});
        enqueue = enqueue.then(() => {
          disk.raw = "second";
          second = saves.queue(file, "second", "second repair");
        });
      }
    });
    await saves.queue(file, "first", "first repair");
    await enqueue;
    await second;
    expect(disk.raw).toBe("second repair");
  });

  it("keeps a requeued snapshot waiting for autosave instead of treating it as a modify event", async () => {
    const file = {}, disk = { raw: "first" };
    let enqueue!: Promise<void>, second!: Promise<void>;
    const saves = new PendingAnchorSaves<object>(async (_file, update) => {
      disk.raw = update(disk.raw);
      if (!enqueue) enqueue = Promise.resolve().then(() => {
        second = saves.queue(file, "second", "second repair");
      });
    });
    await saves.queue(file, "first", "first repair");
    await enqueue; await second;
    expect(disk.raw).toBe("first repair");
    disk.raw = "second"; await saves.modified(file);
    expect(disk.raw).toBe("second repair");
  });

  it("ignores a teardown save queued after the file was deleted", async () => {
    const h = harness("edited");
    h.saves.forget(h.file);
    await h.saves.queue(h.file, "edited", "repaired");
    expect(h.disk.writes).toBe(0);
  });

  it("does not apply an older modify event to a newer queued snapshot", async () => {
    const h = harness("old");
    const first = h.saves.queue(h.file, "old", "old repair");
    const modified = h.saves.modified(h.file);
    const second = h.saves.queue(h.file, "edited", "repaired");
    await Promise.all([first, modified, second]);
    expect(h.disk.raw).toBe("old");
    h.disk.raw = "edited";
    await h.saves.modified(h.file);
    expect(h.disk.raw).toBe("repaired");
  });

});
