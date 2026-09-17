import { describe, expect, it } from 'vitest';
import { bucketExchanges, buildExchangeDraft, computeTrafficMetrics } from './index.js';
import type { MissExchange } from '@uipilot/core';

const sample: MissExchange[] = [
  {
    text: 'make a tourney',
    kind: 'unknown',
    at: 't1',
    llmReply: 'Use Create tournament',
    proposed: { type: 'goto', stepId: 'create_tournament', aliases: ['make a tourney'] },
  },
  {
    text: 'what is pricing',
    kind: 'unknown',
    at: 't2',
    llmReply: 'See billing FAQ',
    proposed: { type: 'faq', faqId: 'pricing' },
  },
  {
    text: 'asdf',
    kind: 'unknown',
    at: 't3',
    llmReply: 'I do not understand',
    proposed: { type: 'refuse' },
  },
];

describe('recalibrate', () => {
  it('buckets by proposed type', () => {
    const b = bucketExchanges(sample);
    expect(b.goto.create_tournament).toHaveLength(1);
    expect(b.faq).toHaveLength(1);
    expect(b.refuse).toHaveLength(1);
  });

  it('builds accept-gated draft', () => {
    const d = buildExchangeDraft(sample);
    expect(d.proposedAliases.create_tournament).toEqual(['make a tourney']);
    expect(d.proposedFaq[0]?.id).toBe('pricing');
    expect(d.note).toMatch(/1A/);
  });

  it('computes fallback share', () => {
    const m = computeTrafficMetrics({
      exchanges: sample,
      misses: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }],
    });
    expect(m.exchangeCount).toBe(3);
    expect(m.fallbackShare).toBe(0.75);
  });
});
