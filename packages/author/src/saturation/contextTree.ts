import type { FlowStepDef, IntentParsePack, StepId } from '@notlm/core';
import { clashDensity, type ClashGroup } from '../detectClashes.js';

export type ContextTreeMode = {
  id: string;
  kind: 'clash-split' | 'clean';
  focusStepIds: StepId[];
  /** Pathname-like hints for the LLM (from step ids). */
  pathnameHints: string[];
  triggerPhrases: string[];
  reason: string;
};

export type ContextTreePlan = {
  muddy: boolean;
  groups: ClashGroup[];
  modes: ContextTreeMode[];
  sharedPhraseCount: number;
};

function pathnameHintsFor(stepIds: StepId[]): string[] {
  const hints: string[] = [];
  for (const id of stepIds) {
    hints.push(`/${id.replace(/_/g, '-')}`);
    hints.push(`/${id.replace(/_/g, '/')}`);
  }
  return [...new Set(hints)];
}

function filterSteps(pack: IntentParsePack, focus: StepId[]): FlowStepDef[] {
  const set = new Set(focus);
  return pack.steps.filter((s) => set.has(s.id));
}

function filterAliases(
  pack: IntentParsePack,
  focus: StepId[]
): Record<string, string[]> {
  const set = new Set(focus);
  const out: Record<string, string[]> = {};
  for (const id of focus) {
    if (set.has(id) && pack.aliases[id]) out[id] = pack.aliases[id]!;
  }
  return out;
}

/**
 * Build generation modes: one per clash group (reduced candidate set) plus a
 * clean mode for non-clashing steps. When nothing is muddy, a single clean mode.
 */
export function buildContextTreePlan(pack: IntentParsePack): ContextTreePlan {
  const density = clashDensity(pack);
  const clashing = new Set<StepId>();
  for (const g of density.groups) {
    for (const id of g.candidates) clashing.add(id);
  }

  const modes: ContextTreeMode[] = [];

  for (const g of density.groups) {
    modes.push({
      id: g.id,
      kind: 'clash-split',
      focusStepIds: g.candidates,
      pathnameHints: pathnameHintsFor(g.candidates),
      triggerPhrases: g.triggerPhrases,
      reason: `Auto-split: shared/near-tied phrases (${g.triggerPhrases.slice(0, 4).join(', ')})`,
    });
  }

  const cleanIds = pack.steps.map((s) => s.id).filter((id) => !clashing.has(id));
  if (cleanIds.length > 0 || modes.length === 0) {
    const focus = cleanIds.length > 0 ? cleanIds : pack.steps.map((s) => s.id);
    modes.push({
      id: 'clean',
      kind: 'clean',
      focusStepIds: focus,
      pathnameHints: pathnameHintsFor(focus),
      triggerPhrases: [],
      reason:
        density.muddy
          ? 'Non-clashing steps (full-pack leftovers)'
          : 'No clashes detected — full pack',
    });
  }

  return {
    muddy: density.muddy,
    groups: density.groups,
    modes,
    sharedPhraseCount: density.sharedPhraseCount,
  };
}

export function pickContextMode(
  plan: ContextTreePlan,
  batchIndex: number
): ContextTreeMode {
  const modes = plan.modes;
  if (modes.length === 0) {
    return {
      id: 'clean',
      kind: 'clean',
      focusStepIds: [],
      pathnameHints: [],
      triggerPhrases: [],
      reason: 'empty',
    };
  }
  return modes[batchIndex % modes.length]!;
}

export function packSliceForMode(
  pack: IntentParsePack,
  mode: ContextTreeMode
): { flowSteps: FlowStepDef[]; intents: { aliases: Record<string, string[]> } } {
  return {
    flowSteps: filterSteps(pack, mode.focusStepIds),
    intents: { aliases: filterAliases(pack, mode.focusStepIds) },
  };
}
