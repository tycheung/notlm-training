/**
 * Constrain DAG mutations to inventory-backed guide ids / controls.
 */

export type InventoryGuideIds = Set<string>;

/** Collect guide ids from common inventory.json shapes. */
export function collectInventoryGuideIds(inventory: unknown): InventoryGuideIds {
  const out = new Set<string>();
  if (!inventory || typeof inventory !== 'object') return out;
  const root = inventory as Record<string, unknown>;

  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.add(v.trim());
  };

  const walk = (node: unknown, depth = 0) => {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    for (const key of ['guideId', 'guide_id', 'id', 'dataGuideId', 'data-guide-id']) {
      push(o[key]);
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };

  walk(root);
  return out;
}

export type DagGuardResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * Validate proposed flow/controls only reference inventory guide ids when
 * inventory is non-empty. Empty inventory → allow NLU-only (reject structural).
 */
export function guardDagMutation(input: {
  inventoryGuideIds: InventoryGuideIds;
  flow?: unknown;
  controls?: unknown;
}): DagGuardResult {
  if (input.inventoryGuideIds.size === 0) {
    return {
      ok: false,
      errors: [
        'DAG mutation refused: inventory.json has no guide ids — stick to intents/scenarios only',
      ],
    };
  }

  const errors: string[] = [];
  const checkId = (id: unknown, where: string) => {
    if (typeof id !== 'string' || !id.trim()) return;
    if (!input.inventoryGuideIds.has(id.trim())) {
      errors.push(`${where}: unknown guide id "${id}" (not in inventory)`);
    }
  };

  if (Array.isArray(input.flow)) {
    for (const step of input.flow) {
      if (!step || typeof step !== 'object') continue;
      const s = step as Record<string, unknown>;
      checkId(s.id, 'flow.step');
      if (Array.isArray(s.requires)) {
        for (const r of s.requires) checkId(r, 'flow.requires');
      }
    }
  }

  if (input.controls && typeof input.controls === 'object') {
    const c = input.controls as Record<string, unknown>;
    for (const [k, v] of Object.entries(c)) {
      if (v && typeof v === 'object') {
        const row = v as Record<string, unknown>;
        checkId(row.guideId ?? row['data-guide-id'] ?? k, `controls.${k}`);
      } else {
        checkId(k, `controls.${k}`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
