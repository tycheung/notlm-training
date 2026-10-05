/**
 * Apply pack patches from hard-fails (LLM proposal or deterministic fixture fold).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LlmProvider } from '@notlm-training/llm';
import type { PackJsonInput } from '@notlm/core';
import { extractJsonText, parseModelJson } from '../parseModelJson.js';
import { lanePatchPrePrompt } from './lanes.js';
import { catalogDigest } from './packLoad.js';
import type { SuiteSummary } from './score.js';

export type PackPatch = {
  aliases?: Record<string, string[]>;
  faq?: Array<{ id: string; aliases: string[]; text?: string }>;
  queryAliases?: Record<string, string[]>;
  mutationAliases?: Record<string, string[]>;
  tourAliases?: Record<string, string[]>;
  searchAliases?: Record<string, string[]>;
  contextAskPhrases?: string[];
  explainLastPhrases?: string[];
  notes?: string;
};

function uniqPush(list: string[], add: string[], cap = 400): string[] {
  const seen = new Set(list.map((s) => s.toLowerCase()));
  const out = [...list];
  for (const a of add) {
    const t = String(a || '').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/** Deterministic fold: append failing utterance to a best-effort catalog bucket. */
export function fixturePatchFromFails(
  pack: PackJsonInput,
  summary: SuiteSummary
): PackPatch {
  const aliases: Record<string, string[]> = {};
  const faq: PackPatch['faq'] = [];
  const queryAliases: Record<string, string[]> = {};
  const mutationAliases: Record<string, string[]> = {};
  const tourAliases: Record<string, string[]> = {};
  const searchAliases: Record<string, string[]> = {};
  const contextAskPhrases: string[] = [];
  const explainLastPhrases: string[] = [];

  const stepIds = Object.keys(pack.intents?.aliases || {});
  const defaultStep = stepIds[0] || pack.flow?.[0]?.id;
  const faqId = pack.faq?.[0]?.id;
  const qId = pack.queries?.[0]?.id;
  const mId = pack.mutations?.[0]?.id;
  const tId = pack.tours?.[0]?.id;
  const sId = pack.search?.[0]?.id;

  for (const f of summary.failures) {
    const text = f.text.trim();
    if (!text) continue;
    switch (f.lane) {
      case 'goto':
        if (defaultStep) {
          aliases[defaultStep] = uniqPush(aliases[defaultStep] || [], [text], 80);
        }
        break;
      case 'faq':
      case 'compare':
        if (faqId) {
          const existing = faq.find((x) => x.id === faqId);
          if (existing) existing.aliases = uniqPush(existing.aliases, [text], 80);
          else faq.push({ id: faqId, aliases: [text] });
        }
        break;
      case 'query':
      case 'handoff':
        if (qId) queryAliases[qId] = uniqPush(queryAliases[qId] || [], [text], 80);
        break;
      case 'mutation':
      case 'mutation_high_risk':
        if (mId) mutationAliases[mId] = uniqPush(mutationAliases[mId] || [], [text], 80);
        break;
      case 'tour':
        if (tId) tourAliases[tId] = uniqPush(tourAliases[tId] || [], [text], 80);
        break;
      case 'search':
        if (sId) searchAliases[sId] = uniqPush(searchAliases[sId] || [], [text], 80);
        break;
      case 'context':
        contextAskPhrases.push(text);
        break;
      case 'audit':
        explainLastPhrases.push(text);
        break;
      default:
        break;
    }
  }

  return {
    aliases,
    faq,
    queryAliases,
    mutationAliases,
    tourAliases,
    searchAliases,
    contextAskPhrases: uniqPush([], contextAskPhrases, 80),
    explainLastPhrases: uniqPush([], explainLastPhrases, 80),
    notes: 'fixture fold from hard fails',
  };
}

export async function proposePackPatch(input: {
  pack: PackJsonInput;
  summary: SuiteSummary;
  provider?: LlmProvider | null;
  fixture?: boolean;
}): Promise<PackPatch> {
  if (input.fixture || !input.provider || !input.summary.failures.length) {
    return fixturePatchFromFails(input.pack, input.summary);
  }
  const prompt = lanePatchPrePrompt({
    productRole: input.pack.manifest?.productRole || 'product assistant',
    failures: input.summary.failures.map((f) => ({
      lane: f.lane,
      text: f.text,
      hit: f.hit,
      reply: f.reply,
    })),
    catalogDigest: catalogDigest(input.pack),
  });
  try {
    const raw = await input.provider.completeChat({
      messages: [
        { role: 'system', content: 'Return only valid JSON pack patch for NotLM.' },
        { role: 'user', content: prompt },
      ],
    });
    const jsonText = extractJsonText(raw) ?? raw;
    const parsed = parseModelJson(jsonText);
    if (parsed.ok && parsed.data && typeof parsed.data === 'object') {
      return parsed.data as PackPatch;
    }
  } catch {
    /* fall through */
  }
  return fixturePatchFromFails(input.pack, input.summary);
}

function mergeAliasMap(
  base: Record<string, string[]> | undefined,
  delta: Record<string, string[]> | undefined
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...(base || {}) };
  for (const [id, als] of Object.entries(delta || {})) {
    out[id] = uniqPush(out[id] || [], als || []);
  }
  return out;
}

/** Apply patch into in-memory PackJsonInput (mutates + returns). */
export function applyPackPatch(pack: PackJsonInput, patch: PackPatch): PackJsonInput {
  if (patch.aliases && Object.keys(patch.aliases).length) {
    pack.intents = {
      ...pack.intents,
      aliases: mergeAliasMap(pack.intents?.aliases, patch.aliases),
    };
  }
  if (patch.faq?.length) {
    const byId = new Map((pack.faq || []).map((f) => [f.id, { ...f }]));
    for (const row of patch.faq) {
      const cur = byId.get(row.id);
      if (cur) {
        cur.aliases = uniqPush(cur.aliases || [], row.aliases || []);
        if (row.text) (cur as { text?: string }).text = row.text;
      } else {
        byId.set(row.id, {
          id: row.id,
          aliases: row.aliases || [],
          text: row.text || row.id,
        } as never);
      }
    }
    pack.faq = [...byId.values()] as PackJsonInput['faq'];
  }
  if (patch.queryAliases) {
    pack.queries = (pack.queries || []).map((q) => ({
      ...q,
      aliases: uniqPush(q.aliases || [], patch.queryAliases?.[q.id] || []),
    }));
  }
  if (patch.mutationAliases) {
    pack.mutations = (pack.mutations || []).map((m) => ({
      ...m,
      aliases: uniqPush(m.aliases || [], patch.mutationAliases?.[m.id] || []),
    }));
  }
  if (patch.tourAliases) {
    pack.tours = (pack.tours || []).map((t) => ({
      ...t,
      aliases: uniqPush(t.aliases || [], patch.tourAliases?.[t.id] || []),
    }));
  }
  if (patch.searchAliases) {
    pack.search = (pack.search || []).map((s) => ({
      ...s,
      aliases: uniqPush(s.aliases || [], patch.searchAliases?.[s.id] || []),
    }));
  }
  if (patch.contextAskPhrases?.length) {
    const merged = uniqPush(
      pack.contextAskPhrases || pack.normalize?.contextAskPhrases || [],
      patch.contextAskPhrases
    );
    pack.contextAskPhrases = merged;
    pack.normalize = {
      ...(pack.normalize || {}),
      contextAskPhrases: merged,
    };
  }
  if (patch.explainLastPhrases?.length) {
    const merged = uniqPush(
      pack.explainLastPhrases || pack.normalize?.explainLastPhrases || [],
      patch.explainLastPhrases
    );
    pack.explainLastPhrases = merged;
    pack.normalize = {
      ...(pack.normalize || {}),
      explainLastPhrases: merged,
    };
  }
  return pack;
}

/** Persist pack JSON pieces that sharpen may have grown. */
export function writePackFolder(packDir: string, pack: PackJsonInput): void {
  mkdirSync(packDir, { recursive: true });
  const write = (name: string, data: unknown) => {
    writeFileSync(join(packDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  };
  write('intents.json', pack.intents);
  if (pack.faq) write('faq.json', pack.faq);
  if (pack.queries) write('queries.json', { queries: pack.queries });
  if (pack.mutations) write('mutations.json', { mutations: pack.mutations });
  if (pack.tours) write('tours.json', { tours: pack.tours });
  if (pack.search) write('search.json', { search: pack.search });
  if (pack.heuristics) write('heuristics.json', pack.heuristics);
  if (pack.normalize) write('normalize.json', pack.normalize);
}

export function writeAutoReport(outDir: string, report: unknown): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
