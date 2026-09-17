import type { IntentParsePack, StepId } from '@uipilot/core';
import { describe, expect, it } from 'vitest';
import { clashDensity, detectClashes } from './detectClashes.js';
import { buildContextTreePlan, pickContextMode } from './saturation/contextTree.js';

const collisionPack: IntentParsePack = {
  steps: [
    {
      id: 'create_list',
      title: 'Create list',
      keywords: ['create', 'list'],
      kind: 'hard',
      requires: [],
    },
    {
      id: 'create_item',
      title: 'Create item',
      keywords: ['create', 'item'],
      kind: 'hard',
      requires: ['create_list'],
    },
    {
      id: 'complete_item',
      title: 'Complete item',
      keywords: ['done'],
      kind: 'hard',
      requires: ['create_item'],
    },
  ],
  aliases: {
    create_list: ['create list', 'new list', 'create'],
    create_item: ['create item', 'add item', 'create'],
    complete_item: ['mark done'],
  },
};

describe('detectClashes', () => {
  it('finds shared alias phrases across steps', () => {
    const groups = detectClashes(collisionPack);
    expect(groups.length).toBeGreaterThan(0);
    const withCreate = groups.find((g) => g.triggerPhrases.includes('create'));
    expect(withCreate?.candidates).toEqual(
      expect.arrayContaining(['create_list', 'create_item'] as StepId[])
    );
    const density = clashDensity(collisionPack);
    expect(density.muddy).toBe(true);
    expect(density.sharedPhraseCount).toBeGreaterThan(0);
  });

  it('builds context-tree modes that split clash groups', () => {
    const plan = buildContextTreePlan(collisionPack);
    expect(plan.muddy).toBe(true);
    expect(plan.modes.some((m) => m.kind === 'clash-split')).toBe(true);
    expect(plan.modes.some((m) => m.kind === 'clean')).toBe(true);
    const split = plan.modes.find((m) => m.kind === 'clash-split')!;
    expect(split.focusStepIds.length).toBeGreaterThanOrEqual(2);
    expect(split.pathnameHints.length).toBeGreaterThan(0);
    expect(pickContextMode(plan, 0).id).toBe(plan.modes[0]!.id);
    expect(pickContextMode(plan, plan.modes.length).id).toBe(plan.modes[0]!.id);
  });

  it('returns a single clean mode when nothing clashes', () => {
    const clean: IntentParsePack = {
      steps: [
        {
          id: 'a',
          title: 'Alpha',
          keywords: ['alpha'],
          kind: 'hard',
          requires: [],
        },
        {
          id: 'b',
          title: 'Beta',
          keywords: ['beta'],
          kind: 'hard',
          requires: [],
        },
      ],
      aliases: { a: ['do alpha'], b: ['do beta'] },
    };
    const plan = buildContextTreePlan(clean);
    expect(plan.muddy).toBe(false);
    expect(plan.modes).toHaveLength(1);
    expect(plan.modes[0]?.kind).toBe('clean');
  });
});
