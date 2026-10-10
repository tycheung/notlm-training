import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketExchanges,
  buildExchangeDraft,
  computeTrafficMetrics,
  foldExchangeDraft,
  loadExchangesFromJson,
  loadExchangesFromRaw,
  writeConversationFoldDraft,
  writeExchangeDraft,
  writeFoldedPackDraft,
} from './index.js';
import type { MissExchange } from '@notlm/core';

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
  {
    text: 'help',
    kind: 'unknown',
    at: 't4',
    llmReply: 'I can guide you',
    proposed: { type: 'meta' },
  },
  {
    text: 'no proposal',
    kind: 'unknown',
    at: 't5',
    llmReply: 'hmm',
  },
  {
    text: 'goto mystery',
    kind: 'unknown',
    at: 't6',
    llmReply: 'try something',
    proposed: { type: 'goto' },
  },
  {
    text: 'faq default aliases',
    kind: 'unknown',
    at: 't7',
    llmReply: 'FAQ body',
    proposed: { type: 'faq', stepId: 'billing' },
  },
];

describe('recalibrate', () => {
  it('buckets by proposed type including unlabeled / unknown step / meta', () => {
    const b = bucketExchanges(sample);
    expect(b.goto.create_tournament).toHaveLength(1);
    expect(b.goto._unknown_step).toHaveLength(1);
    expect(b.faq).toHaveLength(2);
    expect(b.refuse).toHaveLength(1);
    expect(b.meta).toHaveLength(1);
    expect(b.unlabeled).toHaveLength(1);

    const weird = bucketExchanges([
      {
        text: 'x',
        kind: 'unknown',
        at: 't',
        llmReply: 'y',
        proposed: { type: 'nope' } as MissExchange['proposed'],
      },
    ]);
    expect(weird.unlabeled).toHaveLength(1);
  });

  it('builds accept-gated draft with corpus + faq defaults', () => {
    const d = buildExchangeDraft(sample);
    expect(d.proposedAliases.create_tournament).toEqual(['make a tourney']);
    expect(d.proposedAliases._unknown_step).toEqual(['goto mystery']);
    expect(d.proposedFaq[0]?.id).toBe('pricing');
    expect(d.proposedFaq[1]?.id).toBe('miss-faq-2');
    expect(d.proposedFaq[1]?.aliases).toEqual(['faq default aliases']);
    expect(d.proposedFaq[1]?.stepId).toBe('billing');
    expect(
      d.proposedCorpus.some(
        (c) => c.expect.stepId === null && c.expect.rawIntent === 'refuse'
      )
    ).toBe(true);
    expect(
      d.proposedCorpus
        .filter((c) => c.expect.stepId === null)
        .every((c) => c.expect.rawIntent === 'refuse')
    ).toBe(true);
    expect(d.buckets.metaCount).toBe(1);
    expect(d.buckets.unlabeledCount).toBe(1);
    expect(d.note).toMatch(/Human-review.*pack accept/);
    expect(d.note).toMatch(/Refuse buckets must not become step aliases/);
  });

  it('computes fallback share and null when no misses', () => {
    const m = computeTrafficMetrics({
      exchanges: sample.slice(0, 3),
      misses: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }],
    });
    expect(m.exchangeCount).toBe(3);
    expect(m.fallbackShare).toBe(0.75);
    expect(m.byProposedType.goto).toBe(1);

    const empty = computeTrafficMetrics({ exchanges: [], misses: [] });
    expect(empty.fallbackShare).toBeNull();

    const onlyEx = computeTrafficMetrics({ exchanges: sample.slice(0, 1) });
    expect(onlyEx.missCount).toBe(1);
    expect(onlyEx.fallbackShare).toBe(1);
  });

  it('loads exchanges from raw JSON / JSONL and JSON values', () => {
    const fromJson = loadExchangesFromRaw(JSON.stringify([sample[0]]));
    expect(fromJson).toHaveLength(1);
    const fromJsonl = loadExchangesFromRaw(`${JSON.stringify(sample[0])}\n`);
    expect(fromJsonl[0]?.text).toBe('make a tourney');
    expect(loadExchangesFromJson([sample[0]])).toHaveLength(1);
  });

  it('writes draft.json under drafts/', () => {
    const home = mkdtempSync(join(tmpdir(), 'notlm-recal-'));
    const outDir = writeExchangeDraft(home, [sample[0]!]);
    expect(outDir).toContain('drafts');
    const draftPath = join(outDir, 'draft.json');
    expect(existsSync(draftPath)).toBe(true);
    const draft = JSON.parse(readFileSync(draftPath, 'utf8'));
    expect(draft.proposedAliases.create_tournament).toEqual(['make a tourney']);
  });

  it('folds exchange draft into pack-accept pieces (merges pack)', () => {
    const home = mkdtempSync(join(tmpdir(), 'notlm-fold-'));
    const pack = join(home, 'pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(
      join(pack, 'intents.json'),
      JSON.stringify({
        aliases: { create_tournament: ['create tournament'] },
        meta: ['help'],
      }),
      'utf8'
    );
    writeFileSync(
      join(pack, 'faq.json'),
      JSON.stringify([{ id: 'keep-me', aliases: ['x'], text: 'keep' }]),
      'utf8'
    );
    writeFileSync(
      join(pack, 'corpus.json'),
      JSON.stringify([{ utterance: 'old', expect: { stepId: 'create_tournament' } }]),
      'utf8'
    );

    const exDir = writeExchangeDraft(home, sample);
    const foldedDir = writeFoldedPackDraft(home, join(exDir, 'draft.json'));
    expect(existsSync(join(foldedDir, 'meta.json'))).toBe(true);
    const meta = JSON.parse(readFileSync(join(foldedDir, 'meta.json'), 'utf8'));
    expect(meta.kind).toBe('exchanges-fold');
    expect(meta.checked).toBe(false);

    const intents = JSON.parse(readFileSync(join(foldedDir, 'intents.json'), 'utf8'));
    expect(intents.aliases.create_tournament).toContain('create tournament');
    expect(intents.aliases.create_tournament).toContain('make a tourney');
    expect(intents.aliases._unknown_step).toBeUndefined();
    expect(intents.meta).toEqual(['help']);

    const faq = JSON.parse(readFileSync(join(foldedDir, 'faq.json'), 'utf8'));
    expect(faq.some((f: { id: string }) => f.id === 'keep-me')).toBe(true);
    expect(faq.some((f: { id: string }) => f.id === 'pricing')).toBe(true);

    const corpus = JSON.parse(readFileSync(join(foldedDir, 'corpus.json'), 'utf8'));
    expect(corpus.some((c: { expect: { stepId: string | null } }) => c.expect.stepId === null)).toBe(
      true
    );

    const scenarios = JSON.parse(
      readFileSync(join(foldedDir, 'scenarios.json'), 'utf8')
    ) as Array<{ utterance: string; expect: { stepId: string | null } }>;
    expect(scenarios.some((s) => s.utterance === 'make a tourney')).toBe(true);
    expect(scenarios.some((s) => s.expect.stepId === null)).toBe(true);
  });

  it('writeFoldedPackDraft unwraps wrapped faq.json / corpus.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'notlm-fold-wrap-'));
    const pack = join(home, 'pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(
      join(pack, 'intents.json'),
      JSON.stringify({ aliases: {} }),
      'utf8'
    );
    writeFileSync(
      join(pack, 'faq.json'),
      JSON.stringify({
        faq: [{ id: 'wrapped-faq', aliases: ['w'], text: 'from wrap' }],
      }),
      'utf8'
    );
    writeFileSync(
      join(pack, 'corpus.json'),
      JSON.stringify({
        corpus: [{ utterance: 'wrapped row', expect: { stepId: null } }],
      }),
      'utf8'
    );
    const exDir = writeExchangeDraft(home, [sample[0]!]);
    const foldedDir = writeFoldedPackDraft(home, join(exDir, 'draft.json'));
    const faq = JSON.parse(readFileSync(join(foldedDir, 'faq.json'), 'utf8'));
    expect(faq.some((f: { id: string }) => f.id === 'wrapped-faq')).toBe(true);
    const corpus = JSON.parse(readFileSync(join(foldedDir, 'corpus.json'), 'utf8'));
    expect(
      corpus.some((c: { utterance: string }) => c.utterance === 'wrapped row')
    ).toBe(true);
  });

  it('foldExchangeDraft rewrites legacy pack corpus stepIds that are query ids', () => {
    const folded = foldExchangeDraft(
      {
        note: 'exchange',
        buckets: {
          faqCount: 0,
          gotoSteps: {},
          metaCount: 0,
          refuseCount: 0,
          unlabeledCount: 0,
        },
        proposedAliases: {},
        proposedFaq: [],
        proposedCorpus: [],
        exchanges: [],
      },
      {
        currentQueries: [
          { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
        ],
        currentCorpus: [
          {
            utterance: 'legacy next tourney',
            expect: { stepId: 'td.next_tournament' },
          },
        ],
        currentScenarios: [
          {
            utterance: 'legacy scenario next',
            expect: { stepId: 'td.next_tournament' },
          },
        ],
        currentIntents: { aliases: {} },
        draftId: 'legacy-corpus-rewrite',
      }
    );
    expect(
      folded.corpus.find((c) => c.utterance === 'legacy next tourney')?.expect
    ).toMatchObject({ stepId: null, queryId: 'td.next_tournament' });
    expect(
      folded.scenarios.find((c) => c.utterance === 'legacy scenario next')?.expect
    ).toMatchObject({ stepId: null, queryId: 'td.next_tournament' });
  });

  it('foldExchangeDraft adds query alias paraphrases to scenarios', () => {
    const folded = foldExchangeDraft(
      {
        note: 'exchange',
        buckets: {
          faqCount: 0,
          gotoSteps: {},
          metaCount: 0,
          refuseCount: 0,
          unlabeledCount: 0,
        },
        proposedAliases: {
          'td.next_tournament': ['whats my next tournament'],
        },
        proposedFaq: [],
        proposedCorpus: [],
        exchanges: [],
      },
      {
        currentQueries: [
          { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
        ],
        currentIntents: { aliases: {} },
        draftId: 'query-alias-scenarios',
      }
    );
    expect(
      folded.scenarios.some(
        (c) =>
          c.utterance === 'whats my next tournament' &&
          (c.expect as { queryId?: string }).queryId === 'td.next_tournament'
      )
    ).toBe(true);
  });

  it('foldExchangeDraft adds FAQ alias paraphrases to scenarios', () => {
    const folded = foldExchangeDraft(
      {
        note: 'faq-scenarios',
        buckets: {
          faqCount: 1,
          gotoSteps: {},
          metaCount: 0,
          refuseCount: 0,
          unlabeledCount: 0,
        },
        proposedAliases: {},
        proposedFaq: [
          {
            id: 'faq-pricing',
            aliases: ['what is pricing', 'how much does it cost'],
            text: 'See Subscription.',
          },
        ],
        proposedCorpus: [],
        exchanges: [],
      },
      { draftId: 'faq-scen' }
    );
    expect(
      folded.scenarios.some(
        (c) =>
          c.utterance === 'what is pricing' &&
          (c.expect as { faqId?: string }).faqId === 'faq-pricing'
      )
    ).toBe(true);
    expect(
      folded.scenarios.some((c) => c.utterance === 'how much does it cost')
    ).toBe(true);
  });

  it('foldExchangeDraft merges FAQ aliases and preserves empty draft text', () => {
    const folded = foldExchangeDraft(
      {
        note: 'exchange',
        buckets: {
          faqCount: 1,
          gotoSteps: {},
          metaCount: 0,
          refuseCount: 0,
          unlabeledCount: 0,
        },
        proposedAliases: {},
        proposedFaq: [
          {
            id: 'pricing',
            aliases: ['  what is pricing  ', 'what is pricing', ''],
            text: '',
          },
        ],
        proposedCorpus: [],
        exchanges: [],
      },
      {
        currentFaq: [
          {
            id: 'pricing',
            aliases: ['price FAQ'],
            text: 'Pricing is monthly.',
            stepId: 'billing',
          },
        ],
      }
    );
    const pricing = folded.faq.find((e) => e.id === 'pricing');
    expect(pricing?.text).toBe('Pricing is monthly.');
    expect(pricing?.stepId).toBe('billing');
    expect(pricing?.aliases).toEqual(['price FAQ', 'what is pricing']);
  });

  it('foldExchangeDraft peels known query ids out of proposedAliases', () => {
    const folded = foldExchangeDraft(
      {
        note: 'exchange',
        buckets: {
          faqCount: 0,
          gotoSteps: {},
          metaCount: 0,
          refuseCount: 0,
          unlabeledCount: 0,
        },
        proposedAliases: {
          'td.next_tournament': ['whats my next tournament'],
          create_list: ['make a list'],
          'td.unknown_query': ['mystery'],
        },
        proposedFaq: [],
        proposedCorpus: [
          {
            utterance: 'whats my next tournament',
            expect: { stepId: 'td.next_tournament' },
          },
          {
            utterance: 'mystery ask',
            expect: { stepId: 'td.unknown_query' },
          },
        ],
        exchanges: [],
      },
      {
        currentQueries: [
          { id: 'td.next_tournament', title: 'Next', aliases: ['next tournament'] },
        ],
        currentIntents: { aliases: {} },
        draftId: 'exchange-peel',
      }
    );
    expect(
      folded.queries?.queries
        .find((q) => q.id === 'td.next_tournament')
        ?.aliases.includes('whats my next tournament')
    ).toBe(true);
    expect(folded.intents.aliases.create_list).toContain('make a list');
    expect(folded.intents.aliases['td.next_tournament']).toBeUndefined();
    expect(folded.intents.aliases['td.unknown_query']).toBeUndefined();
    const qRow = folded.corpus.find((c) => c.utterance === 'whats my next tournament');
    expect(qRow?.expect).toMatchObject({
      stepId: null,
      queryId: 'td.next_tournament',
    });
    const dropped = folded.corpus.find((c) => c.utterance === 'mystery ask');
    expect(dropped?.expect).toMatchObject({
      stepId: null,
      rawIntent: 'refuse',
    });
    expect((dropped?.expect as { queryId?: string }).queryId).toBeUndefined();
  });

  it('foldExchangeDraft merges proposedQueryAliases alongside proposedFaq', () => {
    const folded = foldExchangeDraft(
      {
        note: 'hybrid',
        buckets: {
          faqCount: 1,
          gotoSteps: {},
          metaCount: 0,
          refuseCount: 0,
          unlabeledCount: 0,
        },
        proposedAliases: {},
        proposedFaq: [
          { id: 'faq-x', aliases: ['what is x'], text: 'X means x.' },
        ],
        proposedCorpus: [],
        exchanges: [],
        proposedQueryAliases: {
          'td.next_tournament': ['when is my next event'],
        },
      } as Parameters<typeof foldExchangeDraft>[0],
      {
        currentQueries: [
          { id: 'td.next_tournament', title: 'Next', aliases: ['next'] },
        ],
        currentFaq: [],
        draftId: 'hybrid-query',
      }
    );
    expect(
      folded.queries?.queries
        .find((q) => q.id === 'td.next_tournament')
        ?.aliases.includes('when is my next event')
    ).toBe(true);
    expect(folded.faq.some((f) => f.id === 'faq-x')).toBe(true);
  });

  it('writeConversationFoldDraft supports review and auto checked flags', () => {
    const home = mkdtempSync(join(tmpdir(), 'notlm-conv-'));
    mkdirSync(join(home, 'pack'), { recursive: true });
    writeFileSync(
      join(home, 'pack', 'intents.json'),
      JSON.stringify({ aliases: { create_list: ['new list'] } }),
      'utf8'
    );
    writeFileSync(join(home, 'pack', 'faq.json'), '[]', 'utf8');
    writeFileSync(join(home, 'pack', 'corpus.json'), '[]', 'utf8');

    const review = writeConversationFoldDraft(
      home,
      {
        proposedAliases: { create_list: ['make list please'] },
        proposedFaq: [],
        proposedCorpus: [
          { utterance: 'make list please', expect: { stepId: 'create_list' } },
        ],
      },
      { checked: false }
    );
    const reviewMeta = JSON.parse(readFileSync(join(review.foldDir, 'meta.json'), 'utf8'));
    expect(reviewMeta.kind).toBe('conversations-fold');
    expect(reviewMeta.checked).toBe(false);

    const auto = writeConversationFoldDraft(
      home,
      {
        proposedAliases: { create_list: ['build a list'] },
        proposedFaq: [{ id: 'f1', aliases: ['what is list'], text: 'A checklist step.' }],
        proposedCorpus: [{ utterance: 'nope', expect: { stepId: null } }],
      },
      { checked: true }
    );
    const autoMeta = JSON.parse(readFileSync(join(auto.foldDir, 'meta.json'), 'utf8'));
    expect(autoMeta.checked).toBe(true);
    const intents = JSON.parse(readFileSync(join(auto.foldDir, 'intents.json'), 'utf8'));
    expect(intents.aliases.create_list).toContain('build a list');
  });
});
