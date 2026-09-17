import { describe, expect, it } from 'vitest';
import type { IntentParsePack } from '@uipilot/core';
import { lexicalNovelty, normalizeForNovelty } from './lexicalNovelty.js';
import {
  parseSignature,
  parseSignatureNovelty,
} from './parseSignatureNovelty.js';
import {
  detectPlateau,
  scoreBatchAgainstPrior,
  updatePlateauState,
} from './novelty.js';
import { mineIntentFailures } from './failureMining.js';
import { runHardAugment, runSaturationLoop } from './saturateLoop.js';
import type { BatchNoveltySummary } from './types.js';

const pack: IntentParsePack = {
  steps: [
    {
      id: 'create_list',
      title: 'Create list',
      keywords: ['list'],
      kind: 'hard',
      requires: [],
    },
    {
      id: 'add_item',
      title: 'Add item',
      keywords: ['item', 'todo'],
      kind: 'hard',
      requires: ['create_list'],
    },
  ],
  aliases: {
    create_list: ['create a list', 'make a new list'],
    add_item: ['add an item', 'add a todo'],
  },
  meta: ['whats_next', 'go_back'],
};

function lowSummary(overrides?: Partial<BatchNoveltySummary>): BatchNoveltySummary {
  return {
    batchId: 'b1',
    size: 100,
    meanNovelty: 0.1,
    meanLexicalNovelty: 0.8,
    shareAboveFloor: 0.05,
    lift: 0.02,
    incrementalNovelty: 0.05,
    belowEpsilon: true,
    noLift: true,
    ...overrides,
  };
}

describe('lexicalNovelty', () => {
  it('scores exact/near paraphrase low and distinct high', () => {
    const prior = ['create a list', 'make a new list'];
    expect(lexicalNovelty('create a list', prior)).toBe(0);
    expect(lexicalNovelty('creat a list', prior)).toBeLessThan(0.6);
    expect(lexicalNovelty('creat a list', prior)).toBeLessThan(
      lexicalNovelty("what's the weather in Paris", prior)
    );
    expect(lexicalNovelty("what's the weather in Paris", prior)).toBeGreaterThan(
      0.55
    );
  });

  it('returns 1 against empty prior', () => {
    expect(lexicalNovelty('anything', [])).toBe(1);
  });

  it('normalizes punctuation', () => {
    expect(normalizeForNovelty('Hello, WORLD!')).toBe('hello world');
  });
});

describe('parseSignatureNovelty', () => {
  it('maps known aliases to step signatures', () => {
    expect(parseSignature('create a list', pack)).toBe('step:create_list');
    expect(parseSignature("what's next", pack)).toMatch(/^meta:/);
  });

  it('scores new signatures higher than repeats', () => {
    const prior = ['step:create_list', 'step:create_list', 'null'];
    expect(parseSignatureNovelty('step:add_item', prior)).toBe(1);
    expect(parseSignatureNovelty('step:create_list', prior)).toBeCloseTo(
      1 / 3,
      5
    );
    expect(parseSignatureNovelty('null', prior)).toBe(0.5);
  });
});

describe('estimateIncrementalNovelty / plateau', () => {
  it('marks classic plateau after K consecutive low batches', () => {
    const low = lowSummary({ size: 10 });
    let consecutiveLow = 0;
    let plateau = false;
    for (let i = 0; i < 2; i++) {
      const next = updatePlateauState({
        previousConsecutiveLow: consecutiveLow,
        summary: { ...low, batchId: `b${i}` },
        batchSize: 10,
        config: { epsilon: 0.15, consecutiveBatches: 2, noLiftBatchSize: 100 },
      });
      consecutiveLow = next.consecutiveLow;
      plateau = next.plateau;
    }
    expect(plateau).toBe(true);
  });

  it('no-lift stop after 5×100 even when lexical stays high', () => {
    const diverseNoLift = lowSummary({
      meanLexicalNovelty: 0.85,
      lift: 0.01,
      noLift: true,
      belowEpsilon: false,
      incrementalNovelty: 0.4,
      shareAboveFloor: 0.4,
    });
    const batches = Array.from({ length: 5 }, (_, i) => ({
      ...diverseNoLift,
      batchId: `nl-${i}`,
    }));
    const detected = detectPlateau(batches, { noLiftPasses: 5, noLiftBatchSize: 100 }, 100);
    expect(detected.noLiftStop).toBe(true);
    expect(detected.stopReason).toBe('no-lift');
    expect(detected.consecutiveNoLift).toBe(5);
  });

  it('scores batch incremental novelty vs prior pool', () => {
    const { scored, summary } = scoreBatchAgainstPrior({
      batchId: 'batch-001',
      utterances: [
        { utterance: 'create a list' },
        { utterance: 'totally unrelated weather query' },
      ],
      priorUtterances: ['create a list', 'make a new list'],
      priorSignatures: ['step:create_list', 'step:create_list'],
      pack,
      config: { noveltyFloor: 0.2, lexicalWeight: 0.55 },
    });
    expect(scored[0]!.novelty).toBeLessThan(scored[1]!.novelty);
    expect(summary.size).toBe(2);
    expect(summary.lift).toBeGreaterThanOrEqual(0);
    expect(summary.meanLexicalNovelty).toBeGreaterThanOrEqual(0);
  });
});

describe('runSaturationLoop', () => {
  it('stops when fixture batches plateau', async () => {
    const batches = [
      ['brand new weather ask one', 'another unique cuisine question'],
      ['create a list', 'make a new list'],
      ['create a list', 'make a new list'],
      ['create a list', 'make a new list'],
    ];
    const result = await runSaturationLoop({
      pack,
      prior: [
        {
          id: 'p1',
          utterance: 'create a list',
          batchId: 'prior',
          parseSignature: 'step:create_list',
        },
        {
          id: 'p2',
          utterance: 'make a new list',
          batchId: 'prior',
          parseSignature: 'step:create_list',
        },
      ],
      batchSize: 2,
      maxBatches: 10,
      config: {
        epsilon: 0.35,
        consecutiveBatches: 2,
        noveltyFloor: 0.4,
        noLiftBatchSize: 100,
      },
      generateBatch: async ({ batchIndex }) =>
        (batches[batchIndex] ?? []).map((utterance, i) => ({
          id: `f-${batchIndex}-${i}`,
          utterance,
        })),
    });
    expect(result.plateau).toBe(true);
    expect(result.batchesRun).toBeGreaterThanOrEqual(2);
    expect(result.report.batches.length).toBe(result.batchesRun);
  });

  it('no-lift stops after 5 passes of 100 with repeated signatures', async () => {
    const priorUtterances = Array.from({ length: 50 }, (_, i) => `seed phrase ${i}`);
    const result = await runSaturationLoop({
      pack,
      prior: priorUtterances.map((utterance, i) => ({
        id: `p-${i}`,
        utterance,
        batchId: 'prior',
        parseSignature: 'null',
      })),
      batchSize: 100,
      maxBatches: 10,
      config: {
        noLiftPasses: 5,
        noLiftBatchSize: 100,
        noLiftEpsilon: 0.05,
        liftFloor: 0.35,
        consecutiveBatches: 99,
        epsilon: 0.001,
      },
      generateBatch: async ({ batchIndex, batchSize }) =>
        Array.from({ length: batchSize }, (_, i) => ({
          id: `nl-${batchIndex}-${i}`,
          utterance: `utterly distinct weather query number ${batchIndex}-${i} xyz${i}`,
        })),
    });
    expect(result.noLiftStop).toBe(true);
    expect(result.stopReason).toBe('no-lift');
    expect(result.batchesRun).toBe(5);
  });
});

describe('runHardAugment', () => {
  it('emits exactly N and ignores plateau', async () => {
    let calls = 0;
    const result = await runHardAugment({
      pack,
      count: 25,
      chunkSize: 10,
      generateBatch: async ({ batchSize }) => {
        calls += 1;
        return Array.from({ length: batchSize }, (_, i) => ({
          id: `h-${calls}-${i}`,
          utterance: `create a list variant ${calls}-${i}`,
        }));
      },
    });
    expect(result.stopReason).toBe('force');
    expect(result.report.forcedCount).toBe(25);
    expect(result.candidates).toHaveLength(25);
    expect(result.batchesRun).toBe(3);
    expect(result.plateau).toBe(false);
  });
});

describe('mineIntentFailures', () => {
  it('emits checklist and draft hints', () => {
    const mined = mineIntentFailures([
      {
        id: 'f1',
        utterance: 'mak a lst',
        ok: false,
        expected: { stepId: 'create_list' },
        actual: { stepId: null, rawIntent: 'unknown', goBack: false, isCorrection: false },
        errors: ['stepId: expected "create_list", got null'],
      },
    ]);
    expect(mined.checklist.length).toBeGreaterThanOrEqual(2);
    expect(mined.draftHints.failingUtterances).toHaveLength(1);
  });
});
