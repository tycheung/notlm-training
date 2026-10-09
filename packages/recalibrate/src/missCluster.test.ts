import { describe, expect, it } from 'vitest';
import {
  annotateClustersWithPack,
  clusterMissRecords,
  draftFromMissClusters,
} from './missCluster.js';

describe('missCluster', () => {
  it('groups near-duplicate misses', () => {
    const clusters = clusterMissRecords([
      { text: 'is max 300 enforced?', kind: 'unknown', at: 't' },
      { text: 'is max 300 enforced for baker?', kind: 'unknown', at: 't' },
      { text: 'write me a weather poem', kind: 'unknown', at: 't' },
    ]);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    const maxCluster = clusters.find((c) =>
      c.members.some((m) => /max 300/i.test(m))
    );
    expect(maxCluster?.count).toBeGreaterThanOrEqual(2);
  });

  it('drafts FAQ aliases from nearest pack hits', () => {
    const clusters = annotateClustersWithPack(
      clusterMissRecords([
        { text: 'is max 300 enforced?', kind: 'unknown', at: 't' },
        { text: 'is max 300 enforced for games?', kind: 'unknown', at: 't' },
      ]),
      {
        faq: [
          {
            id: 'faq-max-300',
            aliases: ['is max 300 enforced', 'what is max 300'],
            text: 'Max 300 caps game scores.',
          },
        ],
      }
    );
    expect(clusters[0]?.nearest?.id).toBe('faq-max-300');
    const draft = draftFromMissClusters(clusters);
    expect(Object.keys(draft.proposedFaqAliases).length).toBeGreaterThan(0);
    expect(draft.proposedCorpus.length).toBeGreaterThan(0);
    expect(draft.note).toMatch(/Miss clusters/);
  });

  it('drafts query aliases and unmapped corpus rows', () => {
    const clusters = annotateClustersWithPack(
      [
        {
          id: 'c1',
          centroid: 'whats my next tournament',
          members: ['whats my next tournament', 'next tournament please'],
          count: 2,
          kinds: { unknown: 2 },
        },
        {
          id: 'c2',
          centroid: 'zzzz unrelated gibberish xyz',
          members: ['zzzz unrelated gibberish xyz'],
          count: 1,
          kinds: { unknown: 1 },
        },
      ],
      {
        queries: [
          {
            id: 'td.next_tournament',
            title: 'Next tournament',
            aliases: ['whats my next tournament', 'next tournament'],
          },
        ],
      }
    );
    const draft = draftFromMissClusters(clusters);
    expect(draft.singletonCount).toBeGreaterThanOrEqual(0);
    expect(
      draft.proposedAliases['td.next_tournament']?.length ||
        draft.proposedCorpus.some((r) => r.expect.queryId === 'td.next_tournament') ||
        draft.proposedCorpus.some((r) => r.expect.stepId === null)
    ).toBeTruthy();
  });
});
