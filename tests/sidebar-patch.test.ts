import { describe, expect, it } from "vitest";
import { planKeyedReconcile } from "../src/sidebar-patch";

describe("planKeyedReconcile", () => {
  it("reuses unchanged cards and rebuilds only the edited thread", () => {
    const existing = [
      { key: "card:a", signature: "thread-a" },
      { key: "card:b", signature: "thread-b" },
      { key: "card:c", signature: "thread-c" },
    ];
    const desired = [
      { key: "card:a", signature: "thread-a" },
      { key: "card:b", signature: "thread-b-reply" },
      { key: "card:c", signature: "thread-c" },
    ];
    const plan = planKeyedReconcile(existing, desired);
    expect(plan.reuse).toEqual([true, false, true]);
    expect(plan.remove).toEqual([]);
  });

  it("removes cards that left the list", () => {
    const plan = planKeyedReconcile(
      [
        { key: "card:a", signature: "a" },
        { key: "card:b", signature: "b" },
      ],
      [{ key: "card:a", signature: "a" }]
    );
    expect(plan.reuse).toEqual([true]);
    expect(plan.remove).toEqual(["card:b"]);
  });

  it("rebuilds every card when forceRebuild is set", () => {
    const items = [
      { key: "card:a", signature: "a" },
      { key: "card:b", signature: "b" },
    ];
    expect(planKeyedReconcile(items, items, true).reuse).toEqual([false, false]);
  });

  it("reorders without rebuilding when only sort changes", () => {
    const plan = planKeyedReconcile(
      [
        { key: "card:a", signature: "a" },
        { key: "card:b", signature: "b" },
      ],
      [
        { key: "card:b", signature: "b" },
        { key: "card:a", signature: "a" },
      ]
    );
    expect(plan.reuse).toEqual([true, true]);
    expect(plan.remove).toEqual([]);
  });
});
