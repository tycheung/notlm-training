import type { ControlInventory, InventoriedControl } from './types.js';

/**
 * Merge crawl results. Prefer incoming rows; keep `existingGuideId` when the
 * prior inventory already had one for a matching control (by guide id,
 * selector hint, or role+name).
 */
export function mergeInventory(
  existing: ControlInventory | null | undefined,
  incoming: ControlInventory
): ControlInventory {
  const priorIndex = new Map<string, InventoriedControl>();
  for (const c of existing?.controls ?? []) {
    for (const key of controlKeys(c)) {
      priorIndex.set(key, c);
    }
  }

  const controls = incoming.controls.map((c) => {
    const prior = findPrior(priorIndex, c);
    if (prior?.existingGuideId) {
      return { ...c, existingGuideId: prior.existingGuideId };
    }
    return c;
  });

  return {
    capturedAt: incoming.capturedAt,
    baseUrl: incoming.baseUrl || existing?.baseUrl || '',
    controls,
  };
}

function controlKeys(c: InventoriedControl): string[] {
  const keys = [`rn:${c.role}|${c.name}`];
  if (c.url) keys.push(`rn:${c.role}|${c.name}|${c.url}`);
  if (c.selectorHint) keys.push(`sel:${c.selectorHint}`);
  if (c.existingGuideId) keys.push(`id:${c.existingGuideId}`);
  if (c.proposedGuideId) keys.push(`prop:${c.proposedGuideId}`);
  return keys;
}

function findPrior(
  index: Map<string, InventoriedControl>,
  c: InventoriedControl
): InventoriedControl | undefined {
  for (const key of controlKeys(c)) {
    const hit = index.get(key);
    if (hit) return hit;
  }
  return undefined;
}
