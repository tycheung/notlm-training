import type { MissExchange, MissProposed } from '@uipilot/core';
import {
  normalizeMissExchangeList,
  parseMissExchanges,
  parseMissRecords,
} from '@uipilot/core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ExchangeBucket = {
  faq: MissExchange[];
  goto: Record<string, MissExchange[]>;
  meta: MissExchange[];
  refuse: MissExchange[];
  unlabeled: MissExchange[];
};

export function bucketExchanges(exchanges: MissExchange[]): ExchangeBucket {
  const out: ExchangeBucket = {
    faq: [],
    goto: {},
    meta: [],
    refuse: [],
    unlabeled: [],
  };
  for (const ex of exchanges) {
    const p = ex.proposed;
    if (!p) {
      out.unlabeled.push(ex);
      continue;
    }
    if (p.type === 'faq') out.faq.push(ex);
    else if (p.type === 'meta') out.meta.push(ex);
    else if (p.type === 'refuse') out.refuse.push(ex);
    else if (p.type === 'goto') {
      const stepId = p.stepId ?? '_unknown_step';
      (out.goto[stepId] ??= []).push(ex);
    } else out.unlabeled.push(ex);
  }
  return out;
}

/** Draft intents aliases + faq stubs for human accept (never writes pack/ directly). */
export function buildExchangeDraft(exchanges: MissExchange[]): {
  note: string;
  buckets: {
    faqCount: number;
    gotoSteps: Record<string, number>;
    metaCount: number;
    refuseCount: number;
    unlabeledCount: number;
  };
  proposedAliases: Record<string, string[]>;
  proposedFaq: Array<{ id: string; aliases: string[]; text: string; stepId?: string }>;
  proposedCorpus: Array<{ utterance: string; expect: { stepId: string | null } }>;
  exchanges: MissExchange[];
} {
  const buckets = bucketExchanges(exchanges);
  const proposedAliases: Record<string, string[]> = {};
  for (const [stepId, list] of Object.entries(buckets.goto)) {
    const texts = [...new Set(list.map((e) => e.text.trim()).filter(Boolean))];
    if (texts.length) proposedAliases[stepId] = texts;
  }
  const proposedFaq = buckets.faq.map((e, i) => ({
    id: e.proposed?.faqId ?? `miss-faq-${i + 1}`,
    aliases: e.proposed?.aliases?.length ? e.proposed.aliases : [e.text],
    text: e.llmReply,
    stepId: e.proposed?.stepId,
  }));
  const proposedCorpus: Array<{ utterance: string; expect: { stepId: string | null } }> = [];
  for (const [stepId, list] of Object.entries(buckets.goto)) {
    for (const e of list) {
      proposedCorpus.push({ utterance: e.text, expect: { stepId } });
    }
  }
  for (const e of buckets.refuse) {
    proposedCorpus.push({ utterance: e.text, expect: { stepId: null } });
  }
  return {
    note: '1A: Human-review then fold into pack/intents.json + faq.json + corpus.json; run intents check; pack accept. Refuse buckets must not become step aliases.',
    buckets: {
      faqCount: buckets.faq.length,
      gotoSteps: Object.fromEntries(
        Object.entries(buckets.goto).map(([k, v]) => [k, v.length])
      ),
      metaCount: buckets.meta.length,
      refuseCount: buckets.refuse.length,
      unlabeledCount: buckets.unlabeled.length,
    },
    proposedAliases,
    proposedFaq,
    proposedCorpus,
    exchanges,
  };
}

export function writeExchangeDraft(
  homeDir: string,
  exchanges: MissExchange[]
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(homeDir, 'drafts', `exchanges-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const draft = buildExchangeDraft(exchanges);
  writeFileSync(join(outDir, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  return outDir;
}

export type TrafficMetrics = {
  missCount: number;
  exchangeCount: number;
  fallbackShare: number | null;
  byProposedType: Record<string, number>;
};

/** Rough local-vs-fallback signal from dumps (misses without reply vs exchanges). */
export function computeTrafficMetrics(opts: {
  exchanges: MissExchange[];
  /** Optional utterance-only miss dump for denominator. */
  misses?: Array<{ text: string }>;
}): TrafficMetrics {
  const exchangeCount = opts.exchanges.length;
  const missCount = opts.misses?.length ?? exchangeCount;
  const byProposedType: Record<string, number> = {};
  for (const ex of opts.exchanges) {
    const t = ex.proposed?.type ?? 'unlabeled';
    byProposedType[t] = (byProposedType[t] ?? 0) + 1;
  }
  return {
    missCount,
    exchangeCount,
    fallbackShare: missCount > 0 ? exchangeCount / missCount : null,
    byProposedType,
  };
}

export function loadExchangesFromRaw(raw: string): MissExchange[] {
  return parseMissExchanges(raw);
}

export function loadExchangesFromJson(data: unknown): MissExchange[] {
  return normalizeMissExchangeList(data);
}

export { parseMissRecords };

export type { MissExchange, MissProposed };
