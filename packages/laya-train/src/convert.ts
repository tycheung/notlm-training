import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadHomeJson,
  loadPackJson,
  resolveNotlmHome,
} from './loadHome.js';
import { aliasesMap, scoreStep } from './intentMatch.js';
import type {
  LabeledUtterance,
  LayaConvertManifest,
  LayaConvertMode,
  LayaTypedDecisionRecord,
  ConvertNotlmResult,
  ScenarioExpect,
} from './types.js';

type FlowStep = { id?: string; title?: string; keywords?: string[] };
type FaqEntry = { id?: string; aliases?: string[]; text?: string };

export type ConvertNotlmOptions = {
  mode?: LayaConvertMode;
  /** Output directory for train.jsonl + manifest.json (default `.notlm/laya`). */
  out?: string;
  productRole?: string;
};

function asSteps(flow: unknown): FlowStep[] {
  return Array.isArray(flow) ? (flow as FlowStep[]) : [];
}

function faqList(faq: unknown): FaqEntry[] {
  return Array.isArray(faq) ? (faq as FaqEntry[]) : [];
}

function shortPhrase(raw: string, max = 48): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  // Aliases in this pack can be multi-KB synthetic dumps — never use those.
  if (t.length > 80 || t.split(',').length > 4) return '';
  return t.slice(0, max);
}

function criteriaText(stepId: string, aliases: string[], keywords: string[], title?: string): string {
  // Laya option budget is ~48 tokens/option. Title + 1–2 short phrases only.
  const parts: string[] = [];
  const titlePart = shortPhrase(title ?? '', 60) || stepId.replace(/_/g, ' ');
  parts.push(titlePart);
  for (const a of [...aliases, ...keywords]) {
    const t = shortPhrase(a, 40);
    if (!t) continue;
    if (parts.some((p) => p.toLowerCase() === t.toLowerCase())) continue;
    parts.push(t);
    if (parts.length >= 3 || parts.join(', ').length > 90) break;
  }
  return parts.join(', ').slice(0, 100);
}

function collectLabeled(home: string): {
  rows: LabeledUtterance[];
  scenariosCount: number;
  corpusCount: number;
} {
  const scenariosRaw = loadHomeJson(home, 'scenarios.json');
  const corpusRaw = loadPackJson(home, 'corpus.json');
  const byUtterance = new Map<string, LabeledUtterance>();
  let scenariosCount = 0;
  let corpusCount = 0;

  const ingest = (list: unknown, source: 'scenarios' | 'corpus') => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { utterance?: string; expect?: ScenarioExpect };
      const utterance = typeof row.utterance === 'string' ? row.utterance.trim() : '';
      if (!utterance || !row.expect || typeof row.expect !== 'object') continue;
      if (source === 'scenarios') scenariosCount += 1;
      else corpusCount += 1;
      byUtterance.set(utterance.toLowerCase(), { utterance, expect: row.expect, source });
    }
  };

  ingest(scenariosRaw, 'scenarios');
  ingest(corpusRaw, 'corpus');

  // Capability catalogs → labeled rows from aliases.
  const capabilityFiles = [
    ['queries.json', 'queries', 'queryId'],
    ['mutations.json', 'mutations', 'mutationId'],
    ['tours.json', 'tours', 'tourId'],
    ['search.json', 'search', 'searchId'],
  ] as const;
  for (const [file, key, expectKey] of capabilityFiles) {
    const raw = loadPackJson(home, file);
    if (!raw || typeof raw !== 'object') continue;
    const list = (raw as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as { id?: string; aliases?: string[]; title?: string };
      if (typeof e.id !== 'string' || !e.id) continue;
      const aliases = Array.isArray(e.aliases) ? e.aliases : [];
      for (const alias of [e.title, ...aliases].filter(
        (a): a is string => typeof a === 'string' && a.trim().length > 0
      )) {
        const utterance = alias.trim();
        if (utterance.length > 120) continue;
        byUtterance.set(utterance.toLowerCase(), {
          utterance,
          expect: { [expectKey]: e.id } as ScenarioExpect,
          source: 'corpus',
        });
        corpusCount += 1;
      }
    }
  }

  // Optional Cursor synth draft.
  const draftPath = join(home, 'drafts', 'capability-synth-20260929', 'utterances.json');
  if (existsSync(draftPath)) {
    try {
      const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as {
        rows?: Array<{ utterance?: string; label?: ScenarioExpect & { ood?: boolean } }>;
      };
      for (const row of draft.rows ?? []) {
        const utterance = typeof row.utterance === 'string' ? row.utterance.trim() : '';
        if (!utterance || !row.label) continue;
        const expect: ScenarioExpect = { ...row.label };
        if (row.label.ood) expect.rawIntent = 'refuse';
        byUtterance.set(utterance.toLowerCase(), {
          utterance,
          expect,
          source: 'corpus',
        });
        corpusCount += 1;
      }
    } catch {
      /* ignore bad draft */
    }
  }

  return { rows: [...byUtterance.values()], scenariosCount, corpusCount };
}

function goldFromExpect(expect: ScenarioExpect): {
  step: string;
  isOod: number;
  faq: string;
} {
  const queryId = expect.queryId?.trim();
  if (queryId) {
    return { step: 'refuse', isOod: 0, faq: `query:${queryId}` };
  }
  const mutationId = expect.mutationId?.trim();
  if (mutationId) {
    return { step: 'refuse', isOod: 0, faq: `mutation:${mutationId}` };
  }
  const tourId = expect.tourId?.trim();
  if (tourId) {
    return { step: 'refuse', isOod: 0, faq: `tour:${tourId}` };
  }
  const searchId = expect.searchId?.trim();
  if (searchId) {
    return { step: 'refuse', isOod: 0, faq: `search:${searchId}` };
  }
  const faqId = expect.faqId?.trim();
  if (faqId || expect.rawIntent === 'faq') {
    return { step: 'refuse', isOod: 0, faq: faqId ?? 'none' };
  }
  if (expect.goBack || expect.rawIntent === 'go_back') {
    return { step: 'refuse', isOod: 0, faq: 'none' };
  }
  if (expect.rawIntent === 'whats_next' || expect.rawIntent === 'help') {
    return { step: 'refuse', isOod: 0, faq: 'none' };
  }
  const stepId = expect.stepId?.trim();
  if (stepId) {
    return { step: stepId, isOod: 0, faq: 'none' };
  }
  if (expect.rawIntent === 'refuse' || expect.rawIntent === 'ood') {
    return { step: 'refuse', isOod: 1, faq: 'none' };
  }
  return { step: 'refuse', isOod: 1, faq: 'none' };
}

function buildStepCriteria(
  stepIds: string[],
  aliases: Record<string, string[]>,
  steps: FlowStep[]
): Record<string, string> {
  const criteria: Record<string, string> = {};
  const byId = new Map(steps.filter((s) => s.id).map((s) => [s.id!, s]));
  for (const id of stepIds) {
    if (id === 'refuse') {
      criteria.refuse = 'off-domain or unknown';
      continue;
    }
    const step = byId.get(id);
    criteria[id] = criteriaText(
      id,
      (aliases[id] ?? []).slice(0, 4),
      Array.isArray(step?.keywords) ? step.keywords.slice(0, 4) : [],
      step?.title
    );
  }
  if (!criteria.refuse) criteria.refuse = 'off-domain or unknown';
  return criteria;
}

function buildFaqCriteria(faqIds: string[], faqs: FaqEntry[]): Record<string, string> {
  const criteria: Record<string, string> = { none: 'not a FAQ' };
  for (const id of faqIds) {
    if (id === 'none') continue;
    if (id.startsWith('query:')) {
      criteria[id] = `data query ${id.slice(6)}`.slice(0, 80);
      continue;
    }
    if (id.startsWith('mutation:')) {
      criteria[id] = `mutation ${id.slice(9)}`.slice(0, 80);
      continue;
    }
    if (id.startsWith('tour:')) {
      criteria[id] = `tour ${id.slice(5)}`.slice(0, 80);
      continue;
    }
    if (id.startsWith('search:')) {
      criteria[id] = `search ${id.slice(7)}`.slice(0, 80);
      continue;
    }
    const entry = faqs.find((f) => f.id === id);
    const title = (entry?.aliases ?? [])[0] ?? id;
    criteria[id] = String(title).slice(0, 80);
  }
  return criteria;
}

function shortlistSteps(
  utterance: string,
  steps: FlowStep[],
  aliases: Record<string, string[]>,
  goldStep: string
): string[] {
  const ids = new Set<string>();
  for (const step of steps) {
    if (typeof step.id !== 'string') continue;
    const score = scoreStep(
      utterance,
      step.id,
      aliases[step.id] ?? [],
      Array.isArray(step.keywords) ? step.keywords : []
    );
    if (score >= 0.5) ids.add(step.id);
  }
  if (goldStep !== 'refuse') ids.add(goldStep);
  ids.add('refuse');
  return [...ids];
}

function shortlistFaqs(utterance: string, faqs: FaqEntry[], goldFaq: string): string[] {
  const ids = new Set<string>(['none']);
  const u = utterance.toLowerCase();
  for (const f of faqs) {
    if (typeof f.id !== 'string') continue;
    for (const a of f.aliases ?? []) {
      if (u.includes(a.toLowerCase())) ids.add(f.id);
    }
  }
  if (goldFaq !== 'none') ids.add(goldFaq);
  return [...ids];
}

export function recordsFromPack(
  home: string,
  mode: LayaConvertMode,
  productRole: string
): {
  records: LayaTypedDecisionRecord[];
  manifestBase: Omit<LayaConvertManifest, 'trainPath' | 'manifestPath' | 'writtenAt'>;
  scenariosCount: number;
  corpusCount: number;
} {
  const flow = loadPackJson(home, 'flow.json');
  const intents = loadPackJson(home, 'intents.json');
  const faq = loadPackJson(home, 'faq.json');
  const steps = asSteps(flow);
  const aliases = aliasesMap(intents);
  const faqs = faqList(faq);
  // Capability catalog ids piggy-back on FAQ choice head with prefixes.
  const capabilityFaqIds: string[] = [];
  for (const [file, key] of [
    ['queries.json', 'queries'],
    ['mutations.json', 'mutations'],
    ['tours.json', 'tours'],
    ['search.json', 'search'],
  ] as const) {
    const raw = loadPackJson(home, file);
    const list =
      raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>)[key]
        : null;
    if (!Array.isArray(list)) continue;
    const prefix =
      key === 'queries'
        ? 'query'
        : key === 'mutations'
          ? 'mutation'
          : key === 'tours'
            ? 'tour'
            : 'search';
    for (const entry of list) {
      const id = (entry as { id?: string })?.id;
      if (typeof id === 'string' && id) capabilityFaqIds.push(`${prefix}:${id}`);
    }
  }
  const { rows, scenariosCount, corpusCount } = collectLabeled(home);

  const allStepIds = steps.map((s) => s.id).filter((id): id is string => typeof id === 'string');
  const fullStepIds = [...allStepIds, 'refuse'];
  const fullFaqIds = [
    ...faqs.map((f) => f.id).filter((id): id is string => typeof id === 'string'),
    ...capabilityFaqIds,
    'none',
  ];

  const oodInstructions = `Is this ask outside ${productRole}?`;

  const records: LayaTypedDecisionRecord[] = [];
  for (const row of rows) {
    const gold = goldFromExpect(row.expect);
    const stepIds =
      mode === 'full'
        ? fullStepIds
        : shortlistSteps(row.utterance, steps, aliases, gold.step);
    const faqIds =
      mode === 'full' ? fullFaqIds : shortlistFaqs(row.utterance, faqs, gold.faq);

    records.push({
      state: row.utterance,
      questions: {
        step: {
          type: 'choice',
          instructions: 'Which workflow step should the coach open?',
          criteria: buildStepCriteria(stepIds, aliases, steps),
        },
        is_ood: {
          type: 'noul',
          instructions: oodInstructions,
        },
        faq: {
          type: 'choice',
          instructions: 'Which FAQ entry fits, if any?',
          criteria: buildFaqCriteria(faqIds, faqs),
        },
      },
      answers: {
        step: { choice: gold.step },
        is_ood: { noul: gold.isOod },
        faq: { choice: gold.faq },
      },
    });
  }

  return {
    records,
    scenariosCount,
    corpusCount,
    manifestBase: {
      mode,
      rows: records.length,
      sources: {
        scenarios: scenariosCount,
        corpus: corpusCount,
        merged: rows.length,
      },
      stepChoicesFull: fullStepIds.length,
      faqChoicesFull: fullFaqIds.length,
    },
  };
}

/** @internal test hook */
export function buildRecordsForRows(
  rows: LabeledUtterance[],
  mode: LayaConvertMode,
  flow: unknown,
  intents: unknown,
  faq: unknown,
  productRole: string
): LayaTypedDecisionRecord[] {
  const steps = asSteps(flow);
  const aliases = aliasesMap(intents);
  const faqs = faqList(faq);
  const allStepIds = steps.map((s) => s.id).filter((id): id is string => typeof id === 'string');
  const fullStepIds = [...allStepIds, 'refuse'];
  const fullFaqIds = [...faqs.map((f) => f.id).filter((id): id is string => typeof id === 'string'), 'none'];
  const oodInstructions = `Is this ask outside ${productRole}?`;
  const records: LayaTypedDecisionRecord[] = [];

  for (const row of rows) {
    const gold = goldFromExpect(row.expect);
    const stepIds =
      mode === 'full'
        ? fullStepIds
        : shortlistSteps(row.utterance, steps, aliases, gold.step);
    const faqIds =
      mode === 'full' ? fullFaqIds : shortlistFaqs(row.utterance, faqs, gold.faq);

    records.push({
      state: row.utterance,
      questions: {
        step: {
          type: 'choice',
          instructions: 'Which workflow step should the coach open?',
          criteria: buildStepCriteria(stepIds, aliases, steps),
        },
        is_ood: { type: 'noul', instructions: oodInstructions },
        faq: {
          type: 'choice',
          instructions: 'Which FAQ entry fits, if any?',
          criteria: buildFaqCriteria(faqIds, faqs),
        },
      },
      answers: {
        step: { choice: gold.step },
        is_ood: { noul: gold.isOod },
        faq: { choice: gold.faq },
      },
    });
  }
  return records;
}

export function convertNotlmToLaya(
  dir: string,
  opts: ConvertNotlmOptions = {}
): ConvertNotlmResult {
  const mode = opts.mode ?? 'full';
  const home = resolveNotlmHome(dir);
  const outDir = opts.out ?? join(home, 'laya');
  const config = loadHomeJson(home, 'config.json') as { productBlurb?: string } | undefined;
  const productRole =
    opts.productRole?.trim() ||
    (typeof config?.productBlurb === 'string' && config.productBlurb.trim()) ||
    'the product guide';

  const { records, manifestBase } = recordsFromPack(home, mode, productRole);
  if (records.length === 0) {
    throw new Error(`No labeled scenarios/corpus under ${home}`);
  }

  mkdirSync(outDir, { recursive: true });
  const trainPath = join(outDir, 'train.jsonl');
  const manifestPath = join(outDir, 'manifest.json');
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(trainPath, body, 'utf8');

  const manifest: LayaConvertManifest = {
    ...manifestBase,
    writtenAt: new Date().toISOString(),
    trainPath,
    manifestPath,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { manifest, records };
}
