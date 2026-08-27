export interface KeyedSignature {
  key: string;
  signature: string;
}

export interface KeyedReconcilePlan {
  /** Parallel to `desired`: reuse the existing node, or render a new one. */
  reuse: boolean[];
  remove: string[];
}

/**
 * Pure keyed diff: reuse a node only when key and signature both match.
 * Order follows `desired`. Nodes whose keys disappeared are listed in `remove`.
 */
export function planKeyedReconcile(
  existing: readonly KeyedSignature[],
  desired: readonly KeyedSignature[],
  forceRebuild = false
): KeyedReconcilePlan {
  const desiredKeys = new Set(desired.map((item) => item.key));
  const existingByKey = new Map(existing.map((item) => [item.key, item]));
  return {
    reuse: desired.map((item) => {
      if (forceRebuild) return false;
      const prev = existingByKey.get(item.key);
      return !!prev && prev.signature === item.signature;
    }),
    remove: existing.filter((item) => !desiredKeys.has(item.key)).map((item) => item.key),
  };
}

/**
 * Patch `parent`'s children after an optional sticky header. Each child that
 * participates must have `data-tc-key` / `data-tc-sig`. Unkeyed leftovers
 * (old empty states) are removed.
 */
export function reconcileKeyedChildren(
  parent: HTMLElement,
  sticky: HTMLElement | null,
  items: readonly KeyedSignature[],
  render: (item: KeyedSignature) => HTMLElement,
  forceRebuild = false
): { reused: number; rebuilt: number } {
  const oldNodes = Array.from(parent.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child !== sticky
  );
  const existing: { key: string; signature: string; node: HTMLElement }[] = [];
  for (const node of oldNodes) {
    const key = node.dataset.tcKey;
    if (!key) continue;
    existing.push({ key, signature: node.dataset.tcSig ?? "", node });
  }
  const byKey = new Map(existing.map((entry) => [entry.key, entry.node]));
  const plan = planKeyedReconcile(
    existing.map(({ key, signature }) => ({ key, signature })),
    items,
    forceRebuild
  );

  const keep = new Set<HTMLElement>();
  const next: HTMLElement[] = [];
  let reused = 0;
  let rebuilt = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (plan.reuse[i]) {
      const node = byKey.get(item.key)!;
      keep.add(node);
      next.push(node);
      reused++;
    } else {
      const node = render(item);
      node.dataset.tcKey = item.key;
      node.dataset.tcSig = item.signature;
      next.push(node);
      rebuilt++;
    }
  }
  for (const node of oldNodes) {
    if (!keep.has(node)) node.remove();
  }
  let cursor: ChildNode | null = sticky ? sticky.nextSibling : parent.firstChild;
  for (const node of next) {
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  return { reused, rebuilt };
}
