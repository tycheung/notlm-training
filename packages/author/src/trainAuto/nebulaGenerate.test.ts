import { describe, expect, it } from 'vitest';
import type { IntentParsePack } from '@uipilot/core';
import {
  composerNebulaBatch,
  mergeAliasesIntoIntents,
  mergeFaqEntries,
  VB_NON_FEATURE_FAQ,
} from '../index.js';

const pack: IntentParsePack = {
  steps: [
    {
      id: 'create_tournament',
      title: 'Create tournament',
      keywords: ['tournament'],
      kind: 'hard',
      requires: [],
    },
    {
      id: 'billing_ready',
      title: 'Billing',
      keywords: ['billing'],
      kind: 'hard',
      requires: [],
    },
  ],
  aliases: {
    create_tournament: ['make tournament'],
    billing_ready: ['open billing'],
  },
  meta: ['go_back'],
  faq: [
    {
      id: 'faq-billing',
      aliases: ['what is billing'],
      text: 'Subscription stuff.',
      stepId: 'billing_ready',
    },
  ],
};

describe('composerNebulaBatch', () => {
  it('emits diverse positives, FAQ, and non-feature candidates', () => {
    const batch = composerNebulaBatch({
      pack,
      batchSize: 24,
      iteration: 3,
      prior: [],
      includeNegatives: true,
    });
    expect(batch.length).toBe(24);
    expect(batch.some((c) => c.expectStepId === 'create_tournament')).toBe(true);
    expect(batch.some((c) => c.faqId === VB_NON_FEATURE_FAQ.id)).toBe(true);
    expect(batch.some((c) => c.kind === 'negative')).toBe(true);
    const texts = new Set(batch.map((c) => c.utterance.toLowerCase()));
    expect(texts.size).toBe(batch.length);
  });

  it('skips prior utterances', () => {
    const first = composerNebulaBatch({
      pack,
      batchSize: 8,
      iteration: 0,
      prior: [],
    });
    const prior = first.map((c) => c.utterance);
    const second = composerNebulaBatch({
      pack,
      batchSize: 8,
      iteration: 0,
      prior,
    });
    for (const c of second) {
      expect(prior.map((p) => p.toLowerCase())).not.toContain(c.utterance.toLowerCase());
    }
  });
});

describe('mergeAliasesIntoIntents soft-cap', () => {
  it('caps per step and reports softCapHit on pack-total budget', () => {
    const intents = {
      aliases: {
        create_tournament: Array.from({ length: 5 }, (_, i) => `a${i}`),
        billing_ready: Array.from({ length: 5 }, (_, i) => `b${i}`),
      },
    };
    const r1 = mergeAliasesIntoIntents(intents, { create_tournament: ['new'] }, 12);
    expect(r1.intents.aliases!.create_tournament).toHaveLength(6);
    expect(r1.softCapHit).toBe(false);
    expect(r1.added).toBe(1);

    // Total aliases (6+6=12) meets pack soft budget even though neither step is full.
    const r2 = mergeAliasesIntoIntents(
      r1.intents,
      { billing_ready: ['overflow-b'] },
      12
    );
    expect(r2.intents.aliases!.billing_ready).toHaveLength(6);
    expect(r2.softCapHit).toBe(true);
  });
});

describe('mergeFaqEntries', () => {
  it('merges aliases and seeds non-feature FAQ text', () => {
    const { faq, softCapHit } = mergeFaqEntries(
      [],
      [
        {
          id: VB_NON_FEATURE_FAQ.id,
          aliases: ['can i take payments from vb directly', 'extra ask'],
          text: VB_NON_FEATURE_FAQ.text,
        },
      ],
      10_000
    );
    expect(softCapHit).toBe(false);
    expect(faq).toHaveLength(1);
    expect(faq[0]!.id).toBe(VB_NON_FEATURE_FAQ.id);
    expect(faq[0]!.aliases).toContain('can i take payments from vb directly');
    expect(faq[0]!.text.toLowerCase()).toMatch(/does not take/);
  });
});
