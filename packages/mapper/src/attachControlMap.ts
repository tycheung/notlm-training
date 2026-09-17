import type { ControlInventory, InventoriedControl } from './types.js';

/** guideId → stepId attachments (interactive map file). */
export type ControlStepMap = Record<string, string>;

export type NavControlStub = {
  id: string;
  stepId: string;
  path: string;
  spotlight: string;
  coachMessage: string;
  role?: string;
  name?: string;
};

export type AttachControlMapResult = {
  controls: NavControlStub[];
  unmatchedGuideIds: string[];
  unusedInventory: string[];
};

function guideKey(c: InventoriedControl): string {
  return c.existingGuideId ?? c.proposedGuideId;
}

/**
 * Attach inventoried CTAs to flow steps via a guideId→stepId map.
 * Emits draft nav-skip stubs for controls.json (path + spotlight = guide id).
 */
export function attachInventoryToSteps(
  inventory: ControlInventory,
  map: ControlStepMap
): AttachControlMapResult {
  const byGuide = new Map<string, InventoriedControl>();
  for (const c of inventory.controls) {
    byGuide.set(guideKey(c), c);
  }

  const controls: NavControlStub[] = [];
  const unmatchedGuideIds: string[] = [];

  for (const [guideId, stepId] of Object.entries(map)) {
    if (!guideId || !stepId) continue;
    const hit = byGuide.get(guideId);
    if (!hit) {
      unmatchedGuideIds.push(guideId);
      continue;
    }
    controls.push({
      id: guideId,
      stepId,
      path: guideId,
      spotlight: guideId,
      coachMessage: `Focus: ${hit.name || stepId}`,
      role: hit.role,
      name: hit.name,
    });
  }

  const attached = new Set(controls.map((c) => c.id));
  const unusedInventory = inventory.controls
    .map(guideKey)
    .filter((id) => id && !attached.has(id));

  return { controls, unmatchedGuideIds, unusedInventory };
}
