/**
 * Morph / expand utterances from pack seeds when no LLM (CI fixture / offline).
 */
import { normalizeUtterance, type PackJsonInput } from '@notlm/core';
import { CAPABILITY_LANES, LANE_EXPECT, type CapabilityLane } from './lanes.js';
import type { StressCase } from './score.js';

const PREFIXES = ['', 'please ', 'can you ', 'hey ', 'quick: '];
const SUFFIXES = ['', ' please', ' now', ' thanks', ' when you can'];

function takeAliases(list: unknown, n: number): string[] {
  const out: string[] = [];
  if (!Array.isArray(list)) return out;
  for (const a of list) {
    const t = String(a || '').trim();
    if (t.length < 3 || t.length > 80) continue;
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

function expand(seeds: string[], per: number, tag: string): string[] {
  if (!seeds.length) seeds = [`${tag} help`];
  const out: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (out.length < per && i < per * 100) {
    const seed = seeds[i % seeds.length]!;
    const p = PREFIXES[Math.floor(i / seeds.length) % PREFIXES.length]!;
    const s =
      SUFFIXES[Math.floor(i / (seeds.length * PREFIXES.length)) % SUFFIXES.length]!;
    const round = Math.floor(i / (seeds.length * PREFIXES.length * SUFFIXES.length));
    let text = `${p}${seed}${s}`.replace(/\s+/g, ' ').trim();
    if (round > 0) text = `${text} ${tag}${round}`;
    i += 1;
    const key = normalizeUtterance(text) || text.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function seedsForLane(lane: CapabilityLane, pack: PackJsonInput): string[] {
  const aliases = pack.intents?.aliases || {};
  const faq = pack.faq || [];
  const queries = pack.queries || [];
  const mutations = pack.mutations || [];
  const tours = pack.tours || [];
  const searches = pack.search || [];
  const n = pack.normalize;

  switch (lane) {
    case 'faq':
    case 'compare':
      return faq.flatMap((f) => takeAliases(f.aliases, 40)).slice(0, 200);
    case 'goto':
      return Object.values(aliases)
        .flatMap((als) => takeAliases(als, 20))
        .slice(0, 300);
    case 'query':
    case 'handoff':
      return queries.flatMap((q) => takeAliases(q.aliases, 40)).slice(0, 200);
    case 'mutation':
      return mutations
        .filter((m) => m.risk !== 'high')
        .flatMap((m) => takeAliases(m.aliases, 40))
        .slice(0, 200);
    case 'mutation_high_risk': {
      const high = mutations.filter((m) => m.risk === 'high');
      const seeds = (high.length ? high : mutations).flatMap((m) =>
        takeAliases(m.aliases, 40)
      );
      return seeds.slice(0, 200);
    }
    case 'tour':
      return tours.flatMap((t) => takeAliases(t.aliases, 40)).slice(0, 200);
    case 'search':
      return searches.flatMap((s) => takeAliases(s.aliases, 40)).slice(0, 200);
    case 'context':
      return takeAliases(
        pack.contextAskPhrases || n?.contextAskPhrases,
        80
      ).concat([
        'why is save greyed out',
        'what am I missing',
        'why is create disabled',
        'checklist blocker',
      ]);
    case 'audit':
      return takeAliases(
        pack.explainLastPhrases || n?.explainLastPhrases,
        80
      ).concat([
        'what did you just do',
        'explain that last action',
        'why did you open that',
      ]);
    case 'ood':
      return [
        'tell me a joke',
        'what is the capital of France',
        'how do I bake an apple pie',
        'who won the world series',
        'write a haiku about cats',
        'play despacito',
      ];
    case 'disambiguation':
      return [
        'I meant the other one',
        'cancel that',
        'nevermind',
        'option 2',
        'number 1',
        'undo that choice',
      ];
    default:
      return [];
  }
}

export function morphCasesForLane(
  lane: CapabilityLane,
  pack: PackJsonInput,
  per: number
): StressCase[] {
  const expect = LANE_EXPECT[lane];
  const texts = expand(seedsForLane(lane, pack), per, lane.slice(0, 3));
  return texts.map((text, i) => ({
    id: `${lane}-${i + 1}`,
    type: lane,
    text,
    expect: expect.expect,
    failIf: expect.failIf,
  }));
}

export function morphFullSuite(pack: PackJsonInput, perLane: number): StressCase[] {
  const out: StressCase[] = [];
  for (const lane of CAPABILITY_LANES) {
    out.push(...morphCasesForLane(lane, pack, perLane));
  }
  return out;
}
