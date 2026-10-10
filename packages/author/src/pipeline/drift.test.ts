import { describe, expect, it } from 'vitest';
import type { PackJsonInput } from '@notlm/core';
import { buildSemanticIndex } from '@notlm/core';
import {
  decideRankerRetrain,
  decideSemanticRebuild,
  rankerSourceDigest,
  semanticSourceDigest,
  serializeExpect,
} from './drift.js';

function pack(partial: Partial<PackJsonInput> = {}): PackJsonInput {
  return {
    manifest: { id: 't' },
    flow: [],
    controls: [],
    intents: { aliases: { step_a: ['open a'] } },
    binders: {},
    faq: [
      {
        id: 'faq-a',
        aliases: ['what is a'],
        text: 'A is a thing.',
      },
    ],
    queries: [{ id: 'q.a', title: 'A', aliases: ['show a'] }],
    ...partial,
  };
}

describe('pipeline drift heuristics', () => {
  it('detects semantic rebuild when index missing', () => {
    const d = decideSemanticRebuild(pack(), null);
    expect(d.needed).toBe(true);
    expect(d.reason).toBe('missing_or_empty_index');
  });

  it('skips semantic rebuild when digest matches', () => {
    const p = pack();
    const digest = semanticSourceDigest(p);
    const index = { ...buildSemanticIndex({ faq: p.faq, queries: p.queries }), sourceDigest: digest };
    const d = decideSemanticRebuild(p, index);
    expect(d.needed).toBe(false);
    expect(d.reason).toBe('digest_match');
  });

  it('detects semantic drift when FAQ aliases change', () => {
    const p = pack();
    const digest = semanticSourceDigest(p);
    const index = { ...buildSemanticIndex({ faq: p.faq, queries: p.queries }), sourceDigest: digest };
    const grown = pack({
      faq: [
        {
          id: 'faq-a',
          aliases: ['what is a', 'explain a please'],
          text: 'A is a thing.',
        },
      ],
    });
    const d = decideSemanticRebuild(grown, index);
    expect(d.needed).toBe(true);
    expect(d.reason).toBe('source_drift');
  });

  it('serializes expect objects stably (not [object Object])', () => {
    expect(serializeExpect({ stepId: 'step_a' })).toBe('stepId=step_a');
    expect(serializeExpect({ stepId: 'step_b', faqId: 'faq-x' })).toContain('faqId=faq-x');
    const a = rankerSourceDigest(pack(), [
      { utterance: 'open a', expect: { stepId: 'step_a' } },
    ]);
    const b = rankerSourceDigest(pack(), [
      { utterance: 'open a', expect: { stepId: 'step_b' } },
    ]);
    expect(a).not.toBe(b);
  });

  it('detects ranker retrain when only expect label changes', () => {
    const p = pack();
    const corpusA = [{ utterance: 'open a', expect: { stepId: 'step_a' } }];
    const first = decideRankerRetrain({
      pack: p,
      corpus: corpusA,
      hasRankerJson: true,
      state: null,
    });
    expect(first.needed).toBe(true);
    const stable = decideRankerRetrain({
      pack: p,
      corpus: corpusA,
      hasRankerJson: true,
      state: { rankerSourceDigest: first.digest },
    });
    expect(stable.needed).toBe(false);
    const labelMoved = decideRankerRetrain({
      pack: p,
      corpus: [{ utterance: 'open a', expect: { stepId: 'step_b' } }],
      hasRankerJson: true,
      state: { rankerSourceDigest: first.digest },
    });
    expect(labelMoved.needed).toBe(true);
    expect(labelMoved.reason).toBe('source_drift');
  });

  it('detects ranker retrain on alias drift', () => {
    const p = pack();
    const corpus = [{ utterance: 'open a', expect: { stepId: 'step_a' } }];
    const first = decideRankerRetrain({
      pack: p,
      corpus,
      hasRankerJson: true,
      state: null,
    });
    const drifted = decideRankerRetrain({
      pack: pack({ intents: { aliases: { step_a: ['open a', 'go to a'] } } }),
      corpus,
      hasRankerJson: true,
      state: { rankerSourceDigest: first.digest },
    });
    expect(drifted.needed).toBe(true);
    expect(drifted.reason).toBe('source_drift');
  });

  it('treats non-empty intent aliases as train surface (matches examplesFromCorpus)', () => {
    const d = decideRankerRetrain({
      pack: pack({ intents: { aliases: { step_a: ['  open a  '] } } }),
      corpus: [],
      hasRankerJson: false,
      force: true,
    });
    expect(d.needed).toBe(true);
    expect(d.reason).toBe('forced_after_pack_growth');
  });

  it('force cannot override empty train surface (query-only / blank aliases)', () => {
    const d = decideRankerRetrain({
      pack: pack({ intents: { aliases: { step_a: ['', '  '] } } }),
      corpus: [{ utterance: 'show a', expect: { queryId: 'q.a' } }],
      hasRankerJson: true,
      force: true,
      state: { rankerSourceDigest: 'stale' },
    });
    expect(d.needed).toBe(false);
    expect(d.reason).toBe('no_labeled_examples');
  });
});
