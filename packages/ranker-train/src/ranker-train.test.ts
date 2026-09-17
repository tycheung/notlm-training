import { describe, expect, it } from 'vitest';
import type { IntentParsePack, ScenarioCase } from '@uipilot/core';
import {
  createJsonHybridParser,
  evaluateRankerSoftScore,
  inferRankerJson,
} from '@uipilot/ranker';
import { examplesFromCorpus, exportIntentOnnx, trainRanker } from './index.js';

const corpus: ScenarioCase[] = [
  { utterance: 'create a list', expect: { stepId: 'create_list' } },
  { utterance: 'make a new list', expect: { stepId: 'create_list' } },
  { utterance: 'add an item', expect: { stepId: 'add_item' } },
  { utterance: 'add a todo', expect: { stepId: 'add_item' } },
  { utterance: 'mark it done', expect: { stepId: 'complete_item' } },
  { utterance: 'complete item', expect: { stepId: 'complete_item' } },
  { utterance: "what's next", expect: { rawIntent: 'whats_next' } },
  { utterance: 'go back', expect: { goBack: true } },
  { utterance: "what's the weather", expect: { stepId: null } },
  {
    utterance: 'rename to name: Shopping',
    expect: { stepId: 'create_list', slots: { name: 'Shopping' } } as ScenarioCase['expect'],
  },
];

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
      keywords: ['item'],
      kind: 'hard',
      requires: ['create_list'],
    },
    {
      id: 'complete_item',
      title: 'Complete item',
      keywords: ['done'],
      kind: 'hard',
      requires: ['add_item'],
    },
  ],
  aliases: {
    create_list: ['create list', 'new list'],
    add_item: ['add item', 'add todo'],
    complete_item: ['complete item', 'mark done'],
  },
  meta: ['whats_next', 'go_back'],
};

describe('ranker train + export', () => {
  it('trains from corpus and ranks intents', () => {
    const examples = examplesFromCorpus(corpus, pack.aliases);
    const model = trainRanker(examples, { dim: 64, epochs: 60, seed: 7 });
    expect(model.intentLabels.length).toBeGreaterThan(2);
    const hit = inferRankerJson(model, 'make a new list');
    expect(hit.backend).toBe('json');
    expect(hit.intent.label).toBe('goto:create_list');
    expect(hit.intent.probability).toBeGreaterThan(0.3);
  });

  it('hybrid parser uses ranker when confident', async () => {
    const model = trainRanker(examplesFromCorpus(corpus, pack.aliases), {
      dim: 64,
      epochs: 60,
      seed: 7,
    });
    const parse = createJsonHybridParser(model, { minProbability: 0.25 });
    const result = await parse('add a todo', pack);
    expect(result.stepId).toBe('add_item');
  });

  it('exports onnx bytes', () => {
    const model = trainRanker(examplesFromCorpus(corpus), { dim: 32, epochs: 5, seed: 1 });
    const bytes = exportIntentOnnx(model);
    expect(bytes.byteLength).toBeGreaterThan(64);
  });

  it('evaluateRankerSoftScore hits soft floor on toy corpus', () => {
    const evalCorpus = corpus.filter(
      (c) => !('stepId' in c.expect && c.expect.stepId === null)
    );
    const model = trainRanker(examplesFromCorpus(evalCorpus, pack.aliases), {
      dim: 64,
      epochs: 80,
      seed: 7,
    });
    const result = evaluateRankerSoftScore(model, evalCorpus, {
      minHitRate: 0.75,
      minProbability: 0.25,
    });
    expect(result.total).toBe(evalCorpus.length);
    expect(result.hitRate).toBeGreaterThanOrEqual(0.75);
    expect(result.ok).toBe(true);
  });
});
