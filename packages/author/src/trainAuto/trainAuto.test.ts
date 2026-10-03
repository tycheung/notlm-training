import { describe, expect, it } from 'vitest';
import {
  appendEvalItems,
  deriveWindowSize,
  diversityGate,
  emptyRollingState,
  fixturePlan,
  hashEmbed,
  cosineSimilarity,
  parsePlannerResponse,
  scoreRolling,
  wilsonLowerBound,
  deriveWorkerCount,
  makeEvalItem,
  guardDagMutation,
  collectInventoryGuideIds,
} from '@notlm/author';
import type { IntentParsePack } from '@notlm/core';

const pack: IntentParsePack = {
  steps: [
    {
      id: 'create_list',
      title: 'Create list',
      keywords: ['create list'],
      kind: 'action',
      requires: [],
    },
    {
      id: 'add_item',
      title: 'Add item',
      keywords: ['add item'],
      kind: 'action',
      requires: [],
    },
  ],
  aliases: {
    create_list: ['create list', 'new list'],
    add_item: ['add item'],
  },
};

describe('trainAuto stats', () => {
  it('defaults 99/99 → window 459', () => {
    expect(deriveWindowSize(0.99, 0.99)).toBe(459);
  });

  it('meets bar when window full and wilson holds', () => {
    let state = emptyRollingState(0.99, 0.99, 5);
    const items = Array.from({ length: 5 }, (_, i) =>
      makeEvalItem('create list', { stepId: 'create_list' }, pack, `i${i}`)
    );
    state = appendEvalItems(state, items);
    expect(state.met).toBe(true);
    expect(state.lastPassRate).toBe(1);
  });

  it('wilson lower bound is below raw rate with failures', () => {
    const lower = wilsonLowerBound(98, 100, 0.99);
    expect(lower).toBeLessThan(0.98);
    expect(lower).toBeGreaterThan(0.9);
  });

  it('scoreRolling not met until window filled', () => {
    let state = emptyRollingState(0.99, 0.99, 10);
    state = appendEvalItems(state, [
      makeEvalItem('create list', { stepId: 'create_list' }, pack, 'a'),
    ]);
    expect(state.met).toBe(false);
    expect(state.items).toHaveLength(1);
  });
});

describe('trainAuto diversity', () => {
  it('rejects near-duplicate cosine', () => {
    const a = hashEmbed('create a tournament now');
    const b = hashEmbed('create a tournament now!');
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9);
    const store = {
      dim: 64,
      items: [
        {
          id: '1',
          utterance: 'create a tournament now',
          vector: a,
          at: new Date().toISOString(),
        },
      ],
    };
    const d = diversityGate({
      utterance: 'create a tournament now!',
      store,
      priorUtterances: ['create a tournament now'],
      maxSimilarity: 0.92,
      minLexicalNovelty: 0.05,
    });
    expect(d.accept).toBe(false);
  });

  it('accepts orthogonal phrasing', () => {
    const store = {
      dim: 64,
      items: [
        {
          id: '1',
          utterance: 'create a tournament now',
          vector: hashEmbed('create a tournament now'),
          at: new Date().toISOString(),
        },
      ],
    };
    const d = diversityGate({
      utterance: 'how do I spin up a brand new event series for weekend scratch?',
      store,
      priorUtterances: ['create a tournament now'],
      maxSimilarity: 0.92,
      minLexicalNovelty: 0.15,
    });
    expect(d.accept).toBe(true);
  });
});

describe('trainAuto planner', () => {
  it('parses toolbox JSON', () => {
    const plan = parsePlannerResponse(
      '```json\n{"action":"generate","rationale":"fill","params":{"batchSize":4,"includeNegatives":true}}\n```'
    );
    expect(plan?.action).toBe('generate');
    expect(plan?.params?.batchSize).toBe(4);
  });

  it('fixture plan cycles', () => {
    const rolling = emptyRollingState(0.99, 0.99, 10);
    expect(fixturePlan(0, rolling).action).toBe('generate');
    expect(fixturePlan(1, rolling).action).toBe('label');
    expect(fixturePlan(2, rolling).action).toBe('tune');
    expect(fixturePlan(3, rolling).action).toBe('eval');
  });
});

describe('trainAuto resources + dag', () => {
  it('deriveWorkerCount at least 1', () => {
    expect(deriveWorkerCount({ maxCpu: 0.8, maxRam: 0.8 })).toBeGreaterThanOrEqual(1);
  });

  it('guardDagMutation refuses empty inventory', () => {
    const g = guardDagMutation({
      inventoryGuideIds: new Set(),
      flow: [{ id: 'x' }],
    });
    expect(g.ok).toBe(false);
  });

  it('collectInventoryGuideIds walks nested', () => {
    const ids = collectInventoryGuideIds({
      controls: [{ guideId: 'a' }, { id: 'b' }],
    });
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(true);
  });
});

describe('trainAuto eval negatives', () => {
  it('rejects tomato sandwich', () => {
    const item = makeEvalItem(
      'give me a recipe for a tomato sandwich',
      { stepId: null },
      pack
    );
    expect(item.passed).toBe(true);
    expect(item.actualStepId).toBeNull();
  });

  it('hits create_list', () => {
    const item = makeEvalItem('create list', { stepId: 'create_list' }, pack);
    expect(item.passed).toBe(true);
  });
});

describe('scoreRolling helper export', () => {
  it('recomputes met', () => {
    const state = scoreRolling({
      ...emptyRollingState(1, 0.99, 2),
      items: [
        makeEvalItem('create list', { stepId: 'create_list' }, pack, '1'),
        makeEvalItem('create list', { stepId: 'create_list' }, pack, '2'),
      ],
    });
    expect(state.met).toBe(true);
  });
});
