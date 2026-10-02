/**
 * Load host `.uipilot/pack` JSON into PackJsonInput (VB / generic SPA layout).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PackJsonInput } from '@uipilot/core';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function tryRead(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  return readJson(path);
}

function unwrapCatalog(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>)[key])) {
    return (raw as Record<string, unknown>)[key] as unknown[];
  }
  return [];
}

function normalizeBinders(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (!Array.isArray(raw) && typeof raw === 'object') return raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (Array.isArray(raw)) {
    for (const row of raw as Array<{ stepId?: string; id?: string; predicate?: unknown }>) {
      if (row?.stepId && row.predicate) out[row.stepId] = row.predicate;
      else if (row?.id && row.predicate) out[row.id] = row.predicate;
    }
  }
  return out;
}

/** Resolve pack folder: `<home>/pack` or `<dir>/.uipilot/pack`. */
export function resolvePackFolder(homeOrPack: string): string {
  if (existsSync(join(homeOrPack, 'manifest.json'))) return homeOrPack;
  const nested = join(homeOrPack, 'pack');
  if (existsSync(join(nested, 'manifest.json'))) return nested;
  const uipilot = join(homeOrPack, '.uipilot', 'pack');
  if (existsSync(join(uipilot, 'manifest.json'))) return uipilot;
  return nested;
}

export function loadPackJsonFromFolder(packDir: string): PackJsonInput {
  const manifest = (tryRead(join(packDir, 'manifest.json')) || {
    id: 'pack',
    productRole: 'product assistant',
  }) as PackJsonInput['manifest'];
  const flow = (tryRead(join(packDir, 'flow.json')) || []) as PackJsonInput['flow'];
  const controls = (tryRead(join(packDir, 'controls.json')) ||
    []) as PackJsonInput['controls'];
  const intents = (tryRead(join(packDir, 'intents.json')) || {
    aliases: {},
  }) as PackJsonInput['intents'];
  const binders = normalizeBinders(tryRead(join(packDir, 'binders.json'))) as PackJsonInput['binders'];
  const faq = unwrapCatalog(tryRead(join(packDir, 'faq.json')), 'faq') as PackJsonInput['faq'];
  const lookups = unwrapCatalog(
    tryRead(join(packDir, 'lookups.json')),
    'lookups'
  ) as PackJsonInput['lookups'];
  const replies = tryRead(join(packDir, 'replies.json')) as PackJsonInput['replies'];
  const normalize = tryRead(join(packDir, 'normalize.json')) as PackJsonInput['normalize'];
  const heuristics = tryRead(join(packDir, 'heuristics.json')) as PackJsonInput['heuristics'];
  const queries = unwrapCatalog(
    tryRead(join(packDir, 'queries.json')),
    'queries'
  ) as PackJsonInput['queries'];
  const mutations = unwrapCatalog(
    tryRead(join(packDir, 'mutations.json')),
    'mutations'
  ) as PackJsonInput['mutations'];
  const tours = unwrapCatalog(
    tryRead(join(packDir, 'tours.json')),
    'tours'
  ) as PackJsonInput['tours'];
  const search = unwrapCatalog(
    tryRead(join(packDir, 'search.json')),
    'search'
  ) as PackJsonInput['search'];

  const subgraphsDir = join(packDir, 'subgraphs');
  let subgraphs: PackJsonInput['subgraphs'];
  if (existsSync(subgraphsDir)) {
    subgraphs = {};
    for (const name of readdirSync(subgraphsDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.replace(/\.json$/, '');
      subgraphs[id] = tryRead(join(subgraphsDir, name)) as never;
    }
  }

  return {
    manifest,
    flow,
    controls,
    intents,
    binders,
    faq,
    lookups,
    replies,
    normalize,
    heuristics,
    queries,
    mutations,
    tours,
    search,
    subgraphs,
  };
}

export function catalogDigest(pack: PackJsonInput): string {
  const stepIds = (pack.flow || []).map((s) => s.id).slice(0, 80);
  const aliasSample = Object.entries(pack.intents?.aliases || {})
    .slice(0, 40)
    .map(([id, als]) => `${id}: ${(als || []).slice(0, 3).join(' | ')}`);
  const faqIds = (pack.faq || []).slice(0, 40).map((f) => f.id);
  const qIds = (pack.queries || []).slice(0, 30).map((q) => q.id);
  const mIds = (pack.mutations || []).slice(0, 30).map((m) => m.id);
  const tIds = (pack.tours || []).slice(0, 20).map((t) => t.id);
  const sIds = (pack.search || []).slice(0, 20).map((s) => s.id);
  return [
    `steps: ${stepIds.join(', ')}`,
    `faq: ${faqIds.join(', ')}`,
    `queries: ${qIds.join(', ')}`,
    `mutations: ${mIds.join(', ')}`,
    `tours: ${tIds.join(', ')}`,
    `search: ${sIds.join(', ')}`,
    'alias samples:',
    ...aliasSample,
  ].join('\n');
}
