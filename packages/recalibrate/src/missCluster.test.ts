import { describe, expect, it } from 'vitest';
import {
  foldMissClusterDraft,
  isMissClusterDraft,
  missClusterToExchangeDraft,
} from './index.js';
import {
  annotateClustersWithPack,
  clusterMissRecords,
  draftFromMissClusters,
  type MissClusterDraft,
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
      draft.proposedQueryAliases['td.next_tournament']?.length ||
        draft.proposedCorpus.some((r) => r.expect.queryId === 'td.next_tournament') ||
        draft.proposedCorpus.some((r) => r.expect.stepId === null)
    ).toBeTruthy();
  });

  it('folds miss-cluster drafts into exchange shape with merged FAQ aliases', () => {
    const draft = draftFromMissClusters(
      annotateClustersWithPack(
        clusterMissRecords([
          { text: 'is max 300 enforced?', kind: 'unknown', at: 't' },
          { text: 'is max 300 enforced for games?', kind: 'unknown', at: 't' },
        ]),
        {
          faq: [
            {
              id: 'faq-max-300',
              aliases: ['is max 300 enforced'],
              text: 'Max 300 caps game scores.',
            },
          ],
        }
      )
    );
    expect(isMissClusterDraft(draft)).toBe(true);
    const folded = missClusterToExchangeDraft(draft, [
      {
        id: 'faq-max-300',
        aliases: ['is max 300 enforced', 'keep me'],
        text: 'Max 300 caps game scores.',
      },
    ]);
    const faq = folded.proposedFaq.find((e) => e.id === 'faq-max-300');
    expect(faq?.aliases).toContain('keep me');
    expect(faq?.aliases.some((a) => /max 300/i.test(a))).toBe(true);
    expect(faq?.text).toBe('Max 300 caps game scores.');
    expect(folded.proposedCorpus.some((c) => c.expect.faqId === 'faq-max-300')).toBe(
      true
    );
  });

  it('does not treat exchange-shaped JSON with empty clusters as miss-cluster', () => {
    expect(
      isMissClusterDraft({
        clusters: [],
        proposedAliases: { create_list: ['make a list'] },
        proposedFaq: [{ id: 'f1', aliases: ['what'], text: 'A' }],
        proposedCorpus: [{ utterance: 'x', expect: { stepId: 'create_list' } }],
      })
    ).toBe(false);
    expect(
      isMissClusterDraft({
        clusters: [],
        proposedFaqAliases: {},
        proposedQueryAliases: {},
        proposedAliases: {},
        proposedCorpus: [],
      })
    ).toBe(false);
    expect(
      isMissClusterDraft({
        clusters: [],
        proposedFaqAliases: { 'faq-x': [] },
        proposedQueryAliases: { 'td.foo': ['', '  '] },
        proposedAliases: {},
        proposedCorpus: [],
      })
    ).toBe(false);
    // Hybrid hand-edit: exchange proposedFaq wins over non-empty FAQ alias maps.
    expect(
      isMissClusterDraft({
        clusters: [],
        proposedFaqAliases: { 'faq-x': ['hello'] },
        proposedQueryAliases: { 'td.foo': ['bar'] },
        proposedFaq: [{ id: 'f1', aliases: ['what'], text: 'A' }],
        proposedAliases: {},
        proposedCorpus: [],
      })
    ).toBe(false);
  });

  it('tolerates non-array alias values in proposedAliases peel', () => {
    const draft: MissClusterDraft = {
      note: 'corrupt',
      clusters: [{ id: 'c1', centroid: 'x', members: ['x'], count: 1, kinds: {} }],
      proposedFaqAliases: {},
      proposedQueryAliases: {
        'td.next_tournament': null as unknown as string[],
      },
      proposedAliases: {
        create_list: null as unknown as string[],
        'td.next_tournament': 'not-an-array' as unknown as string[],
      },
      proposedCorpus: [],
      singletonCount: 0,
    };
    expect(() =>
      foldMissClusterDraft(draft, {
        currentQueries: [
          { id: 'td.next_tournament', title: 'Next', aliases: ['next'] },
        ],
        currentIntents: { aliases: {} },
        draftId: 'non-array-aliases',
      })
    ).not.toThrow();
  });

  it('drops unknown ids from proposedQueryAliases (parity with proposedAliases peel)', () => {
    const draft: MissClusterDraft = {
      note: 'hand-edited',
      clusters: [{ id: 'c1', centroid: 'x', members: ['x'], count: 1, kinds: {} }],
      proposedFaqAliases: {},
      proposedQueryAliases: {
        'td.next_tournament': ['next tourney'],
        'td.unknown_query': ['mystery'],
      },
      proposedAliases: {},
      proposedCorpus: [],
      singletonCount: 0,
    };
    const folded = foldMissClusterDraft(draft, {
      currentQueries: [
        { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
      ],
      currentIntents: { aliases: {} },
      draftId: 'query-map-filter',
    });
    const ids = folded.queries?.queries.map((q) => q.id) ?? [];
    expect(ids).toContain('td.next_tournament');
    expect(ids).not.toContain('td.unknown_query');
    expect(
      folded.queries?.queries
        .find((q) => q.id === 'td.next_tournament')
        ?.aliases.includes('next tourney')
    ).toBe(true);
  });

  it('cluster fold adds peeled query aliases to scenarios', () => {
    const draft: MissClusterDraft = {
      note: 'cluster',
      clusters: [{ id: 'c1', centroid: 'x', members: ['x'], count: 1, kinds: {} }],
      proposedFaqAliases: {},
      proposedQueryAliases: {
        'td.next_tournament': ['whats my next tournament'],
      },
      proposedAliases: {},
      proposedCorpus: [],
      singletonCount: 0,
    };
    const folded = foldMissClusterDraft(draft, {
      currentQueries: [
        { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
      ],
      currentIntents: { aliases: {} },
      draftId: 'cluster-query-scenarios',
    });
    expect(
      folded.scenarios.some(
        (c) =>
          c.utterance === 'whats my next tournament' &&
          (c.expect as { queryId?: string }).queryId === 'td.next_tournament'
      )
    ).toBe(true);
  });

  it('cluster fold rewrites corpus stepId that are known query ids', () => {
    const draft: MissClusterDraft = {
      note: 'cluster',
      clusters: [{ id: 'c1', centroid: 'x', members: ['x'], count: 1, kinds: {} }],
      proposedFaqAliases: {},
      proposedQueryAliases: {},
      proposedAliases: {},
      proposedCorpus: [
        {
          utterance: 'whats my next tournament',
          expect: { stepId: 'td.next_tournament' },
        },
      ],
      singletonCount: 0,
    };
    const folded = foldMissClusterDraft(draft, {
      currentQueries: [
        { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
      ],
      currentIntents: { aliases: {} },
      draftId: 'cluster-corpus-rewrite',
    });
    const row = folded.corpus.find((c) => c.utterance === 'whats my next tournament');
    expect(row?.expect).toMatchObject({
      stepId: null,
      queryId: 'td.next_tournament',
    });
  });

  it('legacy cluster fold routes known query ids to queries.json, not intents', () => {
    const legacy: MissClusterDraft = {
      note: 'legacy',
      clusters: [
        {
          id: 'c1',
          centroid: 'next tournament',
          members: ['next tournament'],
          count: 1,
          kinds: { unknown: 1 },
        },
      ],
      proposedFaqAliases: {},
      // Pre-split drafts put query ids in proposedAliases (no proposedQueryAliases).
      proposedAliases: {
        'td.next_tournament': ['whats my next tournament'],
        create_list: ['make a list'],
      },
      proposedCorpus: [],
      singletonCount: 0,
    };
    const folded = foldMissClusterDraft(legacy, {
      currentQueries: [
        { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
      ],
      currentIntents: { aliases: {} },
      draftId: 'legacy-fold-test',
    });
    expect(folded.queries?.queries.some((q) => q.id === 'td.next_tournament')).toBe(
      true
    );
    expect(
      folded.queries?.queries
        .find((q) => q.id === 'td.next_tournament')
        ?.aliases.includes('whats my next tournament')
    ).toBe(true);
    expect(folded.intents.aliases.create_list).toContain('make a list');
    expect(folded.intents.aliases['td.next_tournament']).toBeUndefined();
  });

  it('half-migrated draft peels known query ids out of proposedAliases', () => {
    const half: MissClusterDraft = {
      note: 'half',
      clusters: [{ id: 'c1', centroid: 'x', members: ['x'], count: 1, kinds: {} }],
      proposedFaqAliases: {},
      proposedQueryAliases: {
        'td.next_tournament': ['next tourney'],
      },
      proposedAliases: {
        'td.next_tournament': ['whats my next tournament'],
        create_list: ['make a list'],
        'td.unknown_query': ['mystery'],
      },
      proposedCorpus: [],
      singletonCount: 0,
    };
    const folded = foldMissClusterDraft(half, {
      currentQueries: [
        { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
      ],
      currentIntents: { aliases: {} },
      draftId: 'half-migrate',
    });
    const q = folded.queries?.queries.find((e) => e.id === 'td.next_tournament');
    expect(q?.aliases).toEqual(
      expect.arrayContaining(['next tourney', 'whats my next tournament'])
    );
    expect(folded.intents.aliases.create_list).toContain('make a list');
    expect(folded.intents.aliases['td.next_tournament']).toBeUndefined();
    expect(folded.intents.aliases['td.unknown_query']).toBeUndefined();
  });

  it('empty proposedQueryAliases still legacy-splits proposedAliases', () => {
    const handMigrated: MissClusterDraft = {
      note: 'hand-migrated',
      clusters: [{ id: 'c1', centroid: 'x', members: ['x'], count: 1, kinds: {} }],
      proposedFaqAliases: {},
      proposedQueryAliases: {},
      proposedAliases: {
        'td.next_tournament': ['whats my next tournament'],
        create_list: ['make a list'],
      },
      proposedCorpus: [],
      singletonCount: 0,
    };
    const folded = foldMissClusterDraft(handMigrated, {
      currentQueries: [
        { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
      ],
      currentIntents: { aliases: {} },
      draftId: 'empty-query-map-legacy',
    });
    expect(
      folded.queries?.queries
        .find((q) => q.id === 'td.next_tournament')
        ?.aliases.includes('whats my next tournament')
    ).toBe(true);
    expect(folded.intents.aliases.create_list).toContain('make a list');
    expect(folded.intents.aliases['td.next_tournament']).toBeUndefined();
  });

  it('legacy cluster fold drops unknown dotted ids instead of minting steps', () => {
    const legacy: MissClusterDraft = {
      note: 'legacy',
      clusters: [{ id: 'c1', centroid: 'x', members: ['x'], count: 1, kinds: {} }],
      proposedFaqAliases: {},
      proposedAliases: {
        'td.unknown_query': ['mystery phrase'],
        real_step: ['open real step'],
      },
      proposedCorpus: [],
      singletonCount: 0,
    };
    const folded = foldMissClusterDraft(legacy, {
      currentQueries: [],
      currentIntents: { aliases: {} },
      draftId: 'legacy-drop-test',
    });
    expect(folded.queries).toBeUndefined();
    expect(folded.intents.aliases['td.unknown_query']).toBeUndefined();
    expect(folded.intents.aliases.real_step).toContain('open real step');
  });
});
