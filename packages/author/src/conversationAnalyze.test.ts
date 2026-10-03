import { describe, expect, it } from 'vitest';
import {
  analyzeConversations,
  fixtureConversationProposal,
} from './conversationAnalyze.js';
import type { ConversationRecord } from '@notlm/core';

const conversations: ConversationRecord[] = [
  {
    conversationId: 'c1',
    startedAt: '2026-01-01T00:00:00.000Z',
    turns: [
      {
        conversationId: 'c1',
        turnId: 't1',
        at: '2026-01-01T00:00:00.000Z',
        role: 'user',
        text: 'make a list',
        outcome: 'hit',
        stepId: 'create_list',
      },
      {
        conversationId: 'c1',
        turnId: 't2',
        at: '2026-01-01T00:00:01.000Z',
        role: 'assistant',
        text: 'Opening create list',
      },
      {
        conversationId: 'c1',
        turnId: 't3',
        at: '2026-01-01T00:00:02.000Z',
        role: 'user',
        text: 'zzz unknown',
        outcome: 'miss',
        missKind: 'unknown',
      },
      {
        conversationId: 'c1',
        turnId: 't4',
        at: '2026-01-01T00:00:03.000Z',
        role: 'assistant',
        text: 'I did not catch that',
      },
    ],
  },
];

describe('fixtureConversationProposal', () => {
  it('promotes hits to aliases and misses to corpus/faq', () => {
    const proposal = fixtureConversationProposal(
      conversations,
      new Set(['create_list'])
    );
    expect(proposal.proposedAliases.create_list).toContain('make a list');
    expect(proposal.proposedCorpus.some((c) => c.expect.stepId === null)).toBe(true);
    expect(proposal.proposedFaq.length).toBeGreaterThan(0);
  });
});

describe('analyzeConversations', () => {
  it('fixture mode skips LLM', async () => {
    const result = await analyzeConversations({
      provider: {
        completeChat: async () => {
          throw new Error('should not call');
        },
      },
      conversations,
      flowSteps: [{ id: 'create_list', title: 'Create list' }],
      fixture: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.proposedAliases.create_list).toContain('make a list');
    }
  });

  it('rewrites unknown step aliases to _unknown_step', async () => {
    const result = await analyzeConversations({
      provider: {
        completeChat: async () =>
          JSON.stringify({
            proposedAliases: { invented_step: ['do the thing'] },
            proposedFaq: [],
            proposedCorpus: [
              { utterance: 'do the thing', expect: { stepId: 'invented_step' } },
            ],
          }),
      },
      conversations,
      flowSteps: [{ id: 'create_list' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.proposedAliases._unknown_step).toContain('do the thing');
      expect(result.proposal.proposedCorpus[0]?.expect.stepId).toBeNull();
    }
  });
});
