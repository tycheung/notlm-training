import type { MissExchange, MissProposed } from '@notlm/core';
import {
  normalizeConversationsDump,
  normalizeMissExchangeList,
  parseMissExchanges,
  parseMissRecords,
} from '@notlm/core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export type FoldedPackPieces = {
  intents: IntentsPiece;
  faq: FaqEntry[];
  corpus: CorpusCase[];
  /** Home-root scenarios.json cases for `notlmCLI intents check`. */
  scenarios: CorpusCase[];
  meta: {
    id: string;
    kind: 'exchanges-fold' | 'conversations-fold';
    createdAt: string;
    checked: boolean;
    source?: string;
  };
};

function readJsonIfExists<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function mergeAliasMaps(
  base: Record<string, string[]>,
  proposed: Record<string, string[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...base };
  for (const [stepId, texts] of Object.entries(proposed)) {
    if (stepId === '_unknown_step') continue; // never promote unknown step ids
    const merged = [...(out[stepId] ?? [])];
    for (const t of texts) {
      const trimmed = t.trim();
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
    draftId?: string;
    sourcePath?: string;
    kind?: 'exchanges-fold' | 'conversations-fold';
    checked?: boolean;
  }
): FoldedPackPieces {
  const currentIntents = (opts?.currentIntents ?? { aliases: {} }) as IntentsPiece;
  const baseAliases =
    currentIntents.aliases && typeof currentIntents.aliases === 'object'
      ? (currentIntents.aliases as Record<string, string[]>)
      : {};
  const aliases = mergeAliasMaps(baseAliases, draft.proposedAliases);

  const faqById = new Map<string, FaqEntry>();
  for (const e of opts?.currentFaq ?? []) {
    if (e?.id) faqById.set(e.id, e);
  }
  for (const e of draft.proposedFaq) {
    faqById.set(e.id, {
      id: e.id,
      aliases: e.aliases,
      text: e.text,
      ...(e.stepId ? { stepId: e.stepId } : {}),
    });
  }

  const corpusSeen = new Set<string>();
  const corpus: CorpusCase[] = [];
  for (const c of opts?.currentCorpus ?? []) {
    const key = `${c.utterance}::${JSON.stringify(c.expect)}`;
    if (corpusSeen.has(key)) continue;
    corpusSeen.add(key);
    corpus.push(c);
  }
  for (const c of draft.proposedCorpus) {
    if (c.expect.stepId === '_unknown_step') {
      corpus.push({ utterance: c.utterance, expect: { stepId: null } });
      continue;
    }
    const key = `${c.utterance}::${JSON.stringify(c.expect)}`;
    if (corpusSeen.has(key)) continue;
    corpusSeen.add(key);
    corpus.push(c);
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
    pushScenario(c.utterance, c.expect);
  }
  for (const c of corpus) {
    // Only newly folded / proposed-shaped cases from this fold's corpus merge —
    // include all corpus rows so accept can grow the gate set.
    pushScenario(c.utterance, c.expect);
  }
  for (const [stepId, texts] of Object.entries(draft.proposedAliases)) {
    if (stepId === '_unknown_step') {
      for (const t of texts) pushScenario(t, { stepId: null });
      continue;
    }
    for (const t of texts) pushScenario(t, { stepId });
  }

  const draftId =
    opts?.draftId ??
    `exchanges-fold-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  return {
    intents: {
      ...currentIntents,
      aliases,
    },
    faq: [...faqById.values()],
    corpus,
    scenarios,
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
function writeFoldedDraftDir(
  outDir: string,
  folded: ReturnType<typeof foldExchangeDraft>
): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'intents.json'), `${JSON.stringify(folded.intents, null, 2)}\n`);
  writeFileSync(join(outDir, 'faq.json'), `${JSON.stringify(folded.faq, null, 2)}\n`);
  writeFileSync(join(outDir, 'corpus.json'), `${JSON.stringify(folded.corpus, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'scenarios.json'),
    `${JSON.stringify(folded.scenarios, null, 2)}\n`
  );
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(folded.meta, null, 2)}\n`);
}

function loadCurrentPackPieces(homeDir: string, packDir?: string) {
  const pack = packDir ?? join(homeDir, 'pack');
  const currentIntents = readJsonIfExists<IntentsPiece>(join(pack, 'intents.json'), {
    aliases: {},
  });
  const currentFaq = readJsonIfExists<FaqEntry[]>(join(pack, 'faq.json'), []);
  const currentCorpus = readJsonIfExists<CorpusCase[]>(join(pack, 'corpus.json'), []);
  const currentScenarios = readJsonIfExists<CorpusCase[]>(
    join(homeDir, 'scenarios.json'),
    []
  );
  return {
    currentIntents,
    currentFaq: Array.isArray(currentFaq) ? currentFaq : [],
    currentCorpus: Array.isArray(currentCorpus) ? currentCorpus : [],
    currentScenarios: Array.isArray(currentScenarios) ? currentScenarios : [],
  };
}

export function writeFoldedPackDraft(
  homeDir: string,
  exchangeDraftPath: string,
  opts?: { packDir?: string }
): string {
  const raw = readFileSync(exchangeDraftPath, 'utf8');
  const draft = JSON.parse(raw) as ExchangeDraftJson;
  if (!draft || typeof draft !== 'object' || !draft.proposedAliases) {
    throw new Error(
      `Invalid exchange draft at ${exchangeDraftPath} (expected proposedAliases)`
    );
  }

  const draftId = `exchanges-fold-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const folded = foldExchangeDraft(draft, {
    ...loadCurrentPackPieces(homeDir, opts?.packDir),
    draftId,
    sourcePath: exchangeDraftPath,
  });

  const outDir = join(homeDir, 'drafts', draftId);
  writeFoldedDraftDir(outDir, folded);
  return outDir;
}

export type ConversationProposalDraft = {
  note?: string;
  proposedAliases: Record<string, string[]>;
  proposedFaq: Array<{ id: string; aliases: string[]; text: string; stepId?: string }>;
  proposedCorpus: Array<{ utterance: string; expect: { stepId: string | null } }>;
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
