import type { MissExchange, MissProposed } from '@notlm/core';
import {
  normalizeConversationsDump,
  normalizeMissExchangeList,
  parseMissExchanges,
  parseMissRecords,
} from '@notlm/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MissClusterDraft } from './missCluster.js';

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
  proposedCorpus: Array<{
    utterance: string;
    expect: { stepId: string | null; rawIntent?: string };
  }>;
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
    aliases: normalizeAliasList(
      e.proposed?.aliases?.length ? e.proposed.aliases : [e.text]
    ),
    text: e.llmReply,
    stepId: e.proposed?.stepId,
  }));
  const proposedCorpus: Array<{
    utterance: string;
    expect: { stepId: string | null; rawIntent?: string };
  }> = [];
  for (const [stepId, list] of Object.entries(buckets.goto)) {
    for (const e of list) {
      proposedCorpus.push({ utterance: e.text, expect: { stepId } });
    }
  }
  for (const e of buckets.refuse) {
    // rawIntent so ranker labels refuse (not unknown) and Laya maps OOD.
    proposedCorpus.push({
      utterance: e.text,
      expect: { stepId: null, rawIntent: 'refuse' },
    });
  }
  return {
    note: 'Human-review, then fold into pack/intents.json + faq.json + corpus.json; run intents check; pack accept. Refuse buckets must not become step aliases.',
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

export type ExchangeDraftJson = ReturnType<typeof buildExchangeDraft>;

export type IntentsPiece = {
  aliases: Record<string, string[]>;
  meta?: string[];
  slots?: Record<string, unknown>;
  confirm?: string[];
  [key: string]: unknown;
};

export type FaqEntry = {
  id: string;
  aliases: string[];
  text: string;
  stepId?: string;
};

export type CorpusCase = {
  utterance: string;
  expect: { stepId: string | null; [key: string]: unknown };
};

export type QueryPiece = {
  id: string;
  title?: string;
  aliases: string[];
  [key: string]: unknown;
};

export type FoldedPackPieces = {
  intents: IntentsPiece;
  faq: FaqEntry[];
  corpus: CorpusCase[];
  /** Home-root scenarios.json cases for `notlmCLI intents check`. */
  scenarios: CorpusCase[];
  /** Optional desk queries (`pack/queries.json` shape `{ queries: [...] }`). */
  queries?: { queries: QueryPiece[] };
  meta: {
    id: string;
    kind: 'exchanges-fold' | 'conversations-fold' | 'misses-cluster-fold';
    createdAt: string;
    checked: boolean;
    source?: string;
  };
};

function readJsonIfExists<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Accept bare arrays or `{ faq: [...] }` / `{ corpus: [...] }` wrappers. */
function unwrapCatalog(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>)[key])) {
    return (raw as Record<string, unknown>)[key] as unknown[];
  }
  return [];
}

/** Trim, drop blanks, dedupe case-insensitively (first spelling wins). */
function normalizeAliasList(aliases: unknown): string[] {
  const out: string[] = [];
  const list = Array.isArray(aliases) ? aliases : [];
  for (const a of list) {
    const trimmed = String(a ?? '').trim();
    if (!trimmed) continue;
    if (out.some((x) => x.toLowerCase() === trimmed.toLowerCase())) continue;
    out.push(trimmed);
  }
  return out;
}

function mergeAliasMaps(
  base: Record<string, string[]>,
  proposed: Record<string, string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...base };
  for (const [stepId, texts] of Object.entries(proposed)) {
    if (stepId === '_unknown_step') continue; // never promote unknown step ids
    const list = Array.isArray(texts) ? texts : [];
    const merged = [...(out[stepId] ?? [])];
    for (const t of list) {
      const trimmed = String(t ?? '').trim();
      if (!trimmed) continue;
      if (!merged.some((x) => x.toLowerCase() === trimmed.toLowerCase())) {
        merged.push(trimmed);
      }
    }
    if (merged.length) out[stepId] = merged;
  }
  return out;
}

/**
 * Expand an exchange draft.json into pack-accept-shaped intents/faq/corpus/scenarios.
 * Merges with existing pack pieces when provided so accept does not wipe pack/.
 */
export function foldExchangeDraft(
  draft: ExchangeDraftJson,
  opts?: {
    currentIntents?: IntentsPiece | Record<string, unknown>;
    currentFaq?: FaqEntry[];
    currentCorpus?: CorpusCase[];
    currentScenarios?: CorpusCase[];
    currentQueries?: QueryPiece[];
    draftId?: string;
    sourcePath?: string;
    kind?: 'exchanges-fold' | 'conversations-fold' | 'misses-cluster-fold';
    checked?: boolean;
  }
): FoldedPackPieces {
  const currentIntents = (opts?.currentIntents ?? { aliases: {} }) as IntentsPiece;
  const baseAliases =
    currentIntents.aliases && typeof currentIntents.aliases === 'object'
      ? (currentIntents.aliases as Record<string, string[]>)
      : {};
  // Peel known query ids out of proposedAliases → queries.json (not intents).
  // Also merge explicit proposedQueryAliases (hybrid hand-edited drafts).
  // Unknown dotted ids are dropped (not minted as steps) — parity with miss-cluster fold.
  const knownQueryIds = new Set((opts?.currentQueries ?? []).map((q) => q.id));
  const rawAliases = draft.proposedAliases ?? {};
  const queryAliasMap: Record<string, string[]> = {};
  const stepAliases: Record<string, string[]> = {};
  const explicitQueryAliases = (
    draft as ExchangeDraftJson & {
      proposedQueryAliases?: Record<string, string[]>;
    }
  ).proposedQueryAliases;
  for (const [id, aliases] of Object.entries(explicitQueryAliases ?? {})) {
    if (!knownQueryIds.has(id)) continue;
    const list = Array.isArray(aliases) ? aliases : [];
    const cleaned = list.map((a) => String(a ?? '').trim()).filter(Boolean);
    if (cleaned.length) queryAliasMap[id] = cleaned;
  }
  for (const [id, aliases] of Object.entries(rawAliases)) {
    const list = Array.isArray(aliases) ? aliases : [];
    if (knownQueryIds.has(id)) {
      const prev = queryAliasMap[id] ?? [];
      const seen = new Set(prev.map((a) => a.toLowerCase()));
      const merged = [...prev];
      for (const a of list) {
        const trimmed = String(a ?? '').trim();
        if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
        seen.add(trimmed.toLowerCase());
        merged.push(trimmed);
      }
      if (merged.length) queryAliasMap[id] = merged;
      continue;
    }
    if (id.includes('.')) continue;
    stepAliases[id] = list;
  }
  const aliases = mergeAliasMaps(baseAliases, stepAliases);

  const faqById = new Map<string, FaqEntry>();
  for (const e of opts?.currentFaq ?? []) {
    if (e?.id) faqById.set(e.id, e);
  }
  for (const e of draft.proposedFaq) {
    if (!e?.id) continue;
    const existing = faqById.get(e.id);
    const mergedAliases = normalizeAliasList([
      ...(existing?.aliases ?? []),
      ...(Array.isArray(e.aliases) ? e.aliases : []),
    ]);
    const text =
      String(e.text ?? '').trim() || String(existing?.text ?? '').trim();
    const stepId = e.stepId || existing?.stepId;
    faqById.set(e.id, {
      id: e.id,
      aliases: mergedAliases,
      text,
      ...(stepId ? { stepId } : {}),
    });
  }

  /** Desk-query ids mislabeled as goto steps must not train ranker goto heads. */
  const rewriteExpect = (
    expect: CorpusCase['expect']
  ): CorpusCase['expect'] => {
    const stepId =
      expect && typeof expect === 'object'
        ? (expect as { stepId?: string | null }).stepId
        : null;
    if (typeof stepId !== 'string') return expect;
    if (knownQueryIds.has(stepId)) {
      const rest = { ...(expect as Record<string, unknown>) };
      delete rest.stepId;
      return { ...rest, stepId: null, queryId: stepId } as CorpusCase['expect'];
    }
    if (stepId.includes('.') && stepId !== '_unknown_step') {
      const rest = { ...(expect as Record<string, unknown>) };
      delete rest.stepId;
      // Unknown dotted desk ids → refuse (parity with `_unknown_step` cluster fold).
      return { ...rest, stepId: null, rawIntent: 'refuse' } as CorpusCase['expect'];
    }
    return expect;
  };

  const corpusSeen = new Set<string>();
  const corpus: CorpusCase[] = [];
  for (const c of opts?.currentCorpus ?? []) {
    const expect = rewriteExpect(c.expect);
    const key = `${c.utterance}::${JSON.stringify(expect)}`;
    if (corpusSeen.has(key)) continue;
    corpusSeen.add(key);
    corpus.push({ utterance: c.utterance, expect });
  }
  for (const c of draft.proposedCorpus) {
    const rewritten = rewriteExpect(c.expect) as Record<string, unknown>;
    if (rewritten.stepId === '_unknown_step') {
      rewritten.stepId = null;
      rewritten.rawIntent = 'refuse';
    }
    const expect = rewritten as CorpusCase['expect'];
    const key = `${c.utterance}::${JSON.stringify(expect)}`;
    if (corpusSeen.has(key)) continue;
    corpusSeen.add(key);
    corpus.push({ utterance: c.utterance, expect });
  }

  // Scenarios for operating intents check: proposed corpus + alias utterances as cases.
  const scenarioSeen = new Set<string>();
  const scenarios: CorpusCase[] = [];
  const pushScenario = (utterance: string, expect: CorpusCase['expect']) => {
    const key = `${utterance}::${JSON.stringify(expect)}`;
    if (scenarioSeen.has(key)) return;
    scenarioSeen.add(key);
    scenarios.push({ utterance, expect });
  };
  for (const c of opts?.currentScenarios ?? []) {
    pushScenario(c.utterance, rewriteExpect(c.expect));
  }
  for (const c of corpus) {
    // Only newly folded / proposed-shaped cases from this fold's corpus merge —
    // include all corpus rows so accept can grow the gate set.
    pushScenario(c.utterance, c.expect);
  }
  for (const [stepId, texts] of Object.entries(stepAliases)) {
    const list = Array.isArray(texts) ? texts : [];
    if (stepId === '_unknown_step') {
      for (const t of list) {
        const u = String(t ?? '').trim();
        if (u) pushScenario(u, { stepId: null, rawIntent: 'refuse' });
      }
      continue;
    }
    for (const t of list) {
      const u = String(t ?? '').trim();
      if (u) pushScenario(u, { stepId });
    }
  }
  // Query paraphrases → scenarios for intents check (parity with step alias rows).
  for (const [queryId, texts] of Object.entries(queryAliasMap)) {
    const list = Array.isArray(texts) ? texts : [];
    for (const t of list) {
      const u = String(t ?? '').trim();
      if (u) pushScenario(u, { stepId: null, queryId });
    }
  }
  // FAQ aliases from exchange drafts → scenarios (parity with cluster proposedCorpus).
  for (const e of draft.proposedFaq ?? []) {
    if (!e?.id) continue;
    const list = Array.isArray(e.aliases) ? e.aliases : [];
    for (const a of list) {
      const u = String(a ?? '').trim();
      if (u) pushScenario(u, { stepId: null, faqId: e.id });
    }
  }

  const draftId =
    opts?.draftId ??
    `exchanges-fold-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const queries =
    Object.keys(queryAliasMap).length > 0
      ? {
          queries: mergeQueryAliasMaps(opts?.currentQueries ?? [], queryAliasMap),
        }
      : undefined;

  return {
    intents: {
      ...currentIntents,
      aliases,
    },
    faq: [...faqById.values()],
    corpus,
    scenarios,
    ...(queries ? { queries } : {}),
    meta: {
      id: draftId,
      kind: opts?.kind ?? 'exchanges-fold',
      createdAt: new Date().toISOString(),
      checked: opts?.checked ?? false,
      ...(opts?.sourcePath ? { source: opts.sourcePath } : {}),
    },
  };
}

/** Write folded pack pieces under `.notlm/drafts/<id>/` for pack accept. */
function writeFoldedDraftDir(outDir: string, folded: FoldedPackPieces): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'intents.json'), `${JSON.stringify(folded.intents, null, 2)}\n`);
  writeFileSync(join(outDir, 'faq.json'), `${JSON.stringify(folded.faq, null, 2)}\n`);
  writeFileSync(join(outDir, 'corpus.json'), `${JSON.stringify(folded.corpus, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'scenarios.json'),
    `${JSON.stringify(folded.scenarios, null, 2)}\n`
  );
  if (folded.queries) {
    writeFileSync(
      join(outDir, 'queries.json'),
      `${JSON.stringify(folded.queries, null, 2)}\n`
    );
  }
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(folded.meta, null, 2)}\n`);
}

function normalizeQueriesPiece(raw: unknown): QueryPiece[] {
  if (Array.isArray(raw)) return raw as QueryPiece[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { queries?: unknown }).queries)) {
    return (raw as { queries: QueryPiece[] }).queries;
  }
  return [];
}

function mergeQueryAliasMaps(
  current: QueryPiece[],
  proposed: Record<string, string[]>
): QueryPiece[] {
  if (!Object.keys(proposed).length) return current;
  const byId = new Map(current.map((q) => [q.id, { ...q, aliases: [...(q.aliases ?? [])] }]));
  for (const [id, aliases] of Object.entries(proposed)) {
    const list = Array.isArray(aliases) ? aliases : [];
    const prev = byId.get(id);
    const seen = new Set((prev?.aliases ?? []).map((a) => a.toLowerCase()));
    const merged = [...(prev?.aliases ?? [])];
    for (const a of list) {
      const trimmed = String(a ?? '').trim();
      if (!trimmed) continue;
      const k = trimmed.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(trimmed);
    }
    if (prev) {
      byId.set(id, { ...prev, aliases: merged });
    } else if (merged.length) {
      byId.set(id, { id, aliases: merged, title: id });
    }
  }
  return [...byId.values()];
}

function loadCurrentPackPieces(homeDir: string, packDir?: string) {
  const pack = packDir ?? join(homeDir, 'pack');
  const currentIntents = readJsonIfExists<IntentsPiece>(join(pack, 'intents.json'), {
    aliases: {},
  });
  const currentFaq = unwrapCatalog(
    readJsonIfExists<unknown>(join(pack, 'faq.json'), []),
    'faq'
  ) as FaqEntry[];
  const currentCorpus = unwrapCatalog(
    readJsonIfExists<unknown>(join(pack, 'corpus.json'), []),
    'corpus'
  ) as CorpusCase[];
  const currentScenarios = unwrapCatalog(
    readJsonIfExists<unknown>(join(homeDir, 'scenarios.json'), []),
    'scenarios'
  ) as CorpusCase[];
  const currentQueries = normalizeQueriesPiece(
    readJsonIfExists<unknown>(join(pack, 'queries.json'), { queries: [] })
  );
  return {
    currentIntents,
    currentFaq,
    currentCorpus,
    currentScenarios,
    currentQueries,
  };
}

/** True when map has at least one non-empty trimmed alias string (not just empty keys). */
function hasAliasMapEntries(map: unknown): boolean {
  if (map == null || typeof map !== 'object' || Array.isArray(map)) return false;
  for (const aliases of Object.values(map as Record<string, unknown>)) {
    if (!Array.isArray(aliases)) continue;
    if (aliases.some((a) => String(a ?? '').trim().length > 0)) return true;
  }
  return false;
}

/** True when draft.json came from `misses cluster`. */
export function isMissClusterDraft(raw: unknown): raw is MissClusterDraft {
  if (!raw || typeof raw !== 'object') return false;
  const d = raw as MissClusterDraft & { proposedFaq?: unknown };
  // Exchange drafts use `proposedFaq[]`; never route them through cluster fold
  // (even if hand-edited hybrid files also carry FAQ/query alias maps).
  if (Array.isArray(d.proposedFaq) && d.proposedFaq.length > 0) return false;
  if (!Array.isArray(d.clusters)) return false;
  // Avoid routing exchange JSON into cluster fold. Empty `{}` alias maps alone
  // (with `clusters: []`) must not hijack — exchange drafts lack real cluster ids.
  return (
    d.clusters.length > 0 ||
    hasAliasMapEntries(d.proposedFaqAliases) ||
    hasAliasMapEntries(d.proposedQueryAliases)
  );
}

/**
 * Expand a miss-cluster draft into exchange-fold shape (merge FAQ aliases with pack).
 * Query aliases are NOT folded into intents — see {@link foldMissClusterDraft}.
 */
export function missClusterToExchangeDraft(
  draft: MissClusterDraft,
  currentFaq?: FaqEntry[]
): ExchangeDraftJson {
  const faqById = new Map((currentFaq ?? []).map((e) => [e.id, e]));
  const proposedFaq = Object.entries(draft.proposedFaqAliases ?? {}).map(
    ([id, aliases]) => {
      const existing = faqById.get(id);
      const merged = normalizeAliasList([
        ...(Array.isArray(existing?.aliases) ? existing.aliases : []),
        ...(Array.isArray(aliases) ? aliases : []),
      ]);
      return {
        id,
        aliases: merged,
        text: existing?.text ?? '',
        ...(existing?.stepId ? { stepId: existing.stepId } : {}),
      };
    }
  );
  const proposedCorpus = (draft.proposedCorpus ?? []).map((c) => ({
    utterance: c.utterance,
    expect: {
      stepId: c.expect.stepId ?? null,
      ...(c.expect.faqId ? { faqId: c.expect.faqId } : {}),
      ...(c.expect.queryId ? { queryId: c.expect.queryId } : {}),
      ...(c.expect.rawIntent ? { rawIntent: c.expect.rawIntent } : {}),
    },
  }));
  return {
    note: draft.note ?? '',
    buckets: {
      faqCount: proposedFaq.length,
      gotoSteps: {},
      metaCount: 0,
      refuseCount: 0,
      unlabeledCount: 0,
    },
    // Step aliases only when proposedQueryAliases is present (new drafts).
    // Legacy split happens in foldMissClusterDraft before this is called.
    proposedAliases: draft.proposedAliases ?? {},
    proposedFaq,
    proposedCorpus,
    exchanges: [],
  };
}

/** Fold miss-cluster draft → pack pieces including queries.json merge. */
export function foldMissClusterDraft(
  draft: MissClusterDraft,
  opts?: {
    currentIntents?: IntentsPiece | Record<string, unknown>;
    currentFaq?: FaqEntry[];
    currentCorpus?: CorpusCase[];
    currentScenarios?: CorpusCase[];
    currentQueries?: QueryPiece[];
    draftId?: string;
    sourcePath?: string;
    checked?: boolean;
  }
): FoldedPackPieces {
  const knownQueryIds = new Set((opts?.currentQueries ?? []).map((q) => q.id));
  // Always peel known query ids out of proposedAliases into the query map
  // (covers legacy null/{} maps and half-migrated drafts with both fields set).
  // Dotted non-query ids are dropped (not minted as steps). Undotted → intents.
  // proposedQueryAliases is filtered to known pack query ids only (parity with peel).
  const rawAliases = draft.proposedAliases ?? {};
  const queryAliasMap: Record<string, string[]> = {};
  for (const [id, aliases] of Object.entries(draft.proposedQueryAliases ?? {})) {
    if (!knownQueryIds.has(id)) continue;
    const list = Array.isArray(aliases) ? aliases : [];
    const cleaned = list.map((a) => String(a ?? '').trim()).filter(Boolean);
    if (cleaned.length) queryAliasMap[id] = cleaned;
  }
  for (const [id, aliases] of Object.entries(rawAliases)) {
    if (!knownQueryIds.has(id)) continue;
    const list = Array.isArray(aliases) ? aliases : [];
    const prev = queryAliasMap[id] ?? [];
    const seen = new Set(prev.map((a) => a.toLowerCase()));
    const merged = [...prev];
    for (const a of list) {
      const trimmed = String(a ?? '').trim();
      if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
      seen.add(trimmed.toLowerCase());
      merged.push(trimmed);
    }
    if (merged.length) queryAliasMap[id] = merged;
  }
  const stepAliases = Object.fromEntries(
    Object.entries(rawAliases)
      .filter(([id]) => !knownQueryIds.has(id) && !id.includes('.'))
      .map(([id, aliases]) => [id, Array.isArray(aliases) ? aliases : []])
  );
  const normalized: MissClusterDraft = {
    ...draft,
    proposedQueryAliases: queryAliasMap,
    proposedAliases: stepAliases,
  };
  const exchange = missClusterToExchangeDraft(normalized, opts?.currentFaq);
  const folded = foldExchangeDraft(exchange, {
    currentIntents: opts?.currentIntents,
    currentFaq: opts?.currentFaq,
    currentCorpus: opts?.currentCorpus,
    currentScenarios: opts?.currentScenarios,
    currentQueries: opts?.currentQueries,
    draftId: opts?.draftId,
    sourcePath: opts?.sourcePath,
    kind: 'misses-cluster-fold',
    checked: opts?.checked,
  });
  // Cluster peel moves query aliases out of proposedAliases before exchange fold,
  // so re-attach paraphrase scenarios for intents check (parity with exchange peel).
  const scenarioSeen = new Set(
    folded.scenarios.map((c) => `${c.utterance}::${JSON.stringify(c.expect)}`)
  );
  const scenarios = [...folded.scenarios];
  for (const [queryId, texts] of Object.entries(queryAliasMap)) {
    const list = Array.isArray(texts) ? texts : [];
    for (const t of list) {
      const u = String(t ?? '').trim();
      if (!u) continue;
      const expect = { stepId: null as string | null, queryId };
      const key = `${u}::${JSON.stringify(expect)}`;
      if (scenarioSeen.has(key)) continue;
      scenarioSeen.add(key);
      scenarios.push({ utterance: u, expect });
    }
  }
  const queries = mergeQueryAliasMaps(opts?.currentQueries ?? [], queryAliasMap);
  return {
    ...folded,
    scenarios,
    // Only emit queries.json when this fold actually adds/merges query aliases.
    ...(Object.keys(queryAliasMap).length ? { queries: { queries } } : {}),
  };
}

export function writeFoldedPackDraft(
  homeDir: string,
  exchangeDraftPath: string,
  opts?: { packDir?: string }
): string {
  const raw = readFileSync(exchangeDraftPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const pieces = loadCurrentPackPieces(homeDir, opts?.packDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  let folded: FoldedPackPieces;

  if (isMissClusterDraft(parsed)) {
    const draftId = `misses-cluster-fold-${stamp}`;
    const normalized: MissClusterDraft = {
      note: parsed.note ?? '',
      clusters: parsed.clusters,
      proposedFaqAliases: parsed.proposedFaqAliases ?? {},
      proposedAliases: parsed.proposedAliases ?? {},
      proposedQueryAliases: parsed.proposedQueryAliases,
      proposedCorpus: parsed.proposedCorpus ?? [],
      singletonCount: parsed.singletonCount ?? 0,
    };
    folded = foldMissClusterDraft(normalized, {
      ...pieces,
      draftId,
      sourcePath: exchangeDraftPath,
    });
  } else if (parsed && typeof parsed === 'object') {
    const rawDraft = parsed as Record<string, unknown>;
    const hasExchangeShape =
      (Array.isArray(rawDraft.proposedFaq) && rawDraft.proposedFaq.length > 0) ||
      hasAliasMapEntries(rawDraft.proposedAliases) ||
      hasAliasMapEntries(rawDraft.proposedQueryAliases) ||
      (Array.isArray(rawDraft.proposedCorpus) &&
        rawDraft.proposedCorpus.length > 0);
    if (!hasExchangeShape) {
      throw new Error(
        `Invalid draft at ${exchangeDraftPath} (expected exchange or misses-cluster draft)`
      );
    }
    const draft = parsed as ExchangeDraftJson & {
      proposedQueryAliases?: Record<string, string[]>;
    };
    const draftId = `exchanges-fold-${stamp}`;
    folded = foldExchangeDraft(
      {
        ...draft,
        proposedFaq: Array.isArray(draft.proposedFaq) ? draft.proposedFaq : [],
        proposedAliases: draft.proposedAliases ?? {},
        proposedCorpus: Array.isArray(draft.proposedCorpus)
          ? draft.proposedCorpus
          : [],
        ...(draft.proposedQueryAliases
          ? { proposedQueryAliases: draft.proposedQueryAliases }
          : {}),
      } as ExchangeDraftJson,
      {
        ...pieces,
        draftId,
        sourcePath: exchangeDraftPath,
      }
    );
  } else {
    throw new Error(
      `Invalid draft at ${exchangeDraftPath} (expected exchange or misses-cluster draft)`
    );
  }

  const outDir = join(homeDir, 'drafts', folded.meta.id);
  writeFoldedDraftDir(outDir, folded);
  return outDir;
}

export type ConversationProposalDraft = {
  note?: string;
  proposedAliases: Record<string, string[]>;
  proposedFaq: Array<{ id: string; aliases: string[]; text: string; stepId?: string }>;
  proposedCorpus: Array<{
    utterance: string;
    expect: { stepId: string | null; rawIntent?: string };
  }>;
  conversations?: unknown;
};

/** Write analysis proposal + folded pack draft under `.notlm/drafts/`. */
export function writeConversationFoldDraft(
  homeDir: string,
  proposal: ConversationProposalDraft,
  opts?: { checked?: boolean; packDir?: string }
): { proposalDir: string; foldDir: string; draftId: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const proposalDir = join(homeDir, 'drafts', `conversations-${stamp}`);
  mkdirSync(proposalDir, { recursive: true });
  const draft: ExchangeDraftJson = {
    note:
      proposal.note ??
      'Conversation analyze: review fold draft then pack accept (or --mode=auto).',
    buckets: {
      faqCount: proposal.proposedFaq.length,
      gotoSteps: Object.fromEntries(
        Object.entries(proposal.proposedAliases).map(([k, v]) => [k, v.length])
      ),
      metaCount: 0,
      refuseCount: 0,
      unlabeledCount: 0,
    },
    proposedAliases: proposal.proposedAliases,
    proposedFaq: proposal.proposedFaq,
    proposedCorpus: proposal.proposedCorpus,
    exchanges: [],
  };
  writeFileSync(join(proposalDir, 'draft.json'), `${JSON.stringify({ ...draft, conversations: proposal.conversations }, null, 2)}\n`);

  const draftId = `conversations-fold-${stamp}`;
  const folded = foldExchangeDraft(draft, {
    ...loadCurrentPackPieces(homeDir, opts?.packDir),
    draftId,
    sourcePath: join(proposalDir, 'draft.json'),
    kind: 'conversations-fold',
    checked: opts?.checked ?? false,
  });

  const foldDir = join(homeDir, 'drafts', draftId);
  writeFoldedDraftDir(foldDir, folded);
  return { proposalDir, foldDir, draftId };
}

export function loadConversationsFromRaw(raw: string): import('@notlm/core').ConversationRecord[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    return normalizeConversationsDump(JSON.parse(trimmed) as unknown);
  }
  // JSONL of records or turns
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
  return normalizeConversationsDump(lines);
}

export function loadConversationsFromJson(
  data: unknown
): import('@notlm/core').ConversationRecord[] {
  return normalizeConversationsDump(data);
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

export {
  annotateClustersWithPack,
  clusterMissRecords,
  draftFromMissClusters,
  type MissCluster,
  type MissClusterDraft,
} from './missCluster.js';
