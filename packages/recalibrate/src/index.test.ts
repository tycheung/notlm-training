import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketExchanges,
  buildExchangeDraft,
  computeTrafficMetrics,
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

    // Exhaustive else branch via cast (defensive).
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
    expect(d.proposedCorpus.some((c) => c.expect.stepId === null)).toBe(true);
    expect(d.buckets.metaCount).toBe(1);
    expect(d.buckets.unlabeledCount).toBe(1);
    expect(d.note).toMatch(/1A/);
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
