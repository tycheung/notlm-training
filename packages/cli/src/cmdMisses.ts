import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeMissRecordList,
  parseMissExchanges,
  parseMissRecords,
  type MissExchange,
  type MissRecord,
} from '@notlm/core';
import {
  annotateClustersWithPack,
  buildExchangeDraft,
  clusterMissRecords,
  draftFromMissClusters,
} from '@notlm-training/recalibrate';
import { buildSemanticIndex, type FaqEntry } from '@notlm/core';
import { validateMissRecordList } from '@notlm/schema';
import { draftsDir, loadPackFolderJson, pathExists, resolveNotlmHome } from './notlmHome.js';
import { FEEDBACK_PATH_FLAGS, positionalDir, takeFlag } from './cliFlags.js';

function writeMissDump(records: ReturnType<typeof parseMissRecords>, outPath?: string): void {
  const payload = `${JSON.stringify(records, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, payload, 'utf8');
    console.log(`Wrote ${records.length} miss records → ${outPath}`);
  } else {
    process.stdout.write(payload);
  }
}

function flowStepIds(home: string): Set<string> {
  const ids = new Set<string>();
  try {
    const files = loadPackFolderJson(home);
    const flow = files.flow;
    if (Array.isArray(flow)) {
      for (const s of flow) {
        if (s && typeof s === 'object' && typeof (s as { id?: string }).id === 'string') {
          ids.add((s as { id: string }).id);
        }
      }
    }
  } catch {
    /* optional pack */
  }
  return ids;
}

function isMissExchange(row: MissRecord): row is MissExchange {
  return typeof (row as MissExchange).llmReply === 'string';
}

function draftFromMissRecords(
  records: MissRecord[],
  stepIds: Set<string>
): ReturnType<typeof buildExchangeDraft> {
  const proposedAliases: Record<string, string[]> = {};
  const proposedFaq: Array<{ id: string; aliases: string[]; text: string; stepId?: string }> = [];
  const proposedCorpus: Array<{ utterance: string; expect: { stepId: string | null } }> = [];
  const byKind = new Map<string, string[]>();

  for (const r of records) {
    const text = (r.text ?? '').trim();
    if (!text) continue;
    const list = byKind.get(r.kind) ?? [];
    if (!list.includes(text)) list.push(text);
    byKind.set(r.kind, list);

    const raw = (r.rawIntent ?? '').trim();
    const gotoFromRaw = raw.startsWith('goto:') ? raw.slice(5).trim() : '';
    const kind = String(r.kind);
    const gotoLike =
      kind === 'goto' ||
      (gotoFromRaw && (stepIds.has(gotoFromRaw) || gotoFromRaw !== 'goto')) ||
      stepIds.has(kind);

    if (gotoLike) {
      const stepId = gotoFromRaw || (stepIds.has(kind) ? kind : '_unknown_step');
      (proposedAliases[stepId] ??= []).push(text);
      proposedCorpus.push({
        utterance: text,
        expect: { stepId: stepId === '_unknown_step' ? null : stepId },
      });
      continue;
    }

    proposedCorpus.push({ utterance: text, expect: { stepId: null } });
  }

  return {
    note: 'Human-review: fold into intents/faq/corpus via feedback fold or pack accept after meta.checked=true.',
    buckets: {
      faqCount: 0,
      gotoSteps: Object.fromEntries(
        Object.entries(proposedAliases).map(([k, v]) => [k, v.length])
      ),
      metaCount: 0,
      refuseCount: proposedCorpus.filter((c) => c.expect.stepId === null).length,
      unlabeledCount: records.length,
    },
    proposedAliases,
    proposedFaq,
    proposedCorpus,
    exchanges: [],
    byKind: Object.fromEntries(byKind),
    records,
  } as ReturnType<typeof buildExchangeDraft> & {
    byKind: Record<string, string[]>;
    records: MissRecord[];
  };
}

/** Export miss records from a JSON/JSONL dump (e.g. localStorage snapshot). */
export async function cmdMissesExport(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error('Usage: notlm-training misses export --from <file.json|jsonl> [--out <path>]');
    process.exitCode = 1;
    return;
  }
  const outPath = takeFlag(args, '--out');
  const records = parseMissRecords(readFileSync(fromPath, 'utf8'));
  writeMissDump(records, outPath);
}

/**
 * GET a host miss-list endpoint, validate portable MissRecord[], write dump.
 */
export async function cmdMissesPull(args: string[]): Promise<void> {
  const url = takeFlag(args, '--url');
  if (!url) {
    console.error('Usage: notlm-training misses pull --url <endpoint> [--out <path>]');
    process.exitCode = 1;
    return;
  }
  const outPath = takeFlag(args, '--out');
  const fetchFn = globalThis.fetch?.bind(globalThis);
  if (!fetchFn) {
    throw new Error('fetch is not available in this runtime');
  }
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`misses pull failed: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as unknown;
  const schema = validateMissRecordList(data);
  if (!schema.ok) {
    throw new Error(
      `Host response is not a portable MissRecord[]:\n${schema.errors.join('\n')}`
    );
  }
  const records = normalizeMissRecordList(data);
  writeMissDump(records, outPath);
}

/**
 * Group unique miss texts into a draft folder for human accept into intents/corpus.
 */
export async function cmdMissesDraftAliases(args: string[]): Promise<void> {
  const dir = positionalDir(args, FEEDBACK_PATH_FLAGS);
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: notlm-training misses draft-aliases --from <file.json|jsonl> [dir]'
    );
    process.exitCode = 1;
    return;
  }

  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const raw = readFileSync(fromPath, 'utf8');
  let draft: Record<string, unknown>;
  try {
    const exchanges = parseMissExchanges(raw);
    if (exchanges.some(isMissExchange)) {
      draft = buildExchangeDraft(exchanges as MissExchange[]) as Record<string, unknown>;
      const byKind = new Map<string, string[]>();
      for (const r of exchanges) {
        const text = (r.text ?? '').trim();
        if (!text) continue;
        const list = byKind.get(r.kind) ?? [];
        if (!list.includes(text)) list.push(text);
        byKind.set(r.kind, list);
      }
      draft.byKind = Object.fromEntries(byKind);
      draft.records = exchanges;
    } else {
      throw new Error('not exchanges');
    }
  } catch {
    const records = parseMissRecords(raw);
    draft = draftFromMissRecords(records, flowStepIds(home)) as Record<string, unknown>;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(draftsDir(home), `misses-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(outDir, 'meta.json'),
    `${JSON.stringify({ checked: false, kind: 'misses-draft' }, null, 2)}\n`,
    'utf8'
  );
  const count = Array.isArray(draft.records) ? draft.records.length : 0;
  console.log(`Miss draft → ${outDir} (${count} records)`);
}

/**
 * Cluster miss utterances and emit alias/ranker training candidates.
 * System One coverage engine: misses → clusters → proposed FAQ/query aliases.
 */
export async function cmdMissesCluster(args: string[]): Promise<void> {
  const dir = positionalDir(args, FEEDBACK_PATH_FLAGS);
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: notlm-training misses cluster --from <file.json|jsonl> [dir]'
    );
    process.exitCode = 1;
    return;
  }
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const records = parseMissRecords(readFileSync(fromPath, 'utf8'));
  let clusters = clusterMissRecords(records);
  try {
    const files = loadPackFolderJson(home);
    const faq = (files.faq as FaqEntry[] | undefined) ?? [];
    const queries = (files.queries as Array<{ id: string; title: string; aliases: string[] }> | undefined) ?? [];
    clusters = annotateClustersWithPack(clusters, {
      faq,
      queries,
      semanticIndex: buildSemanticIndex({ faq, queries }),
    });
  } catch {
    /* pack optional */
  }

  const draft = draftFromMissClusters(clusters);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(draftsDir(home), `misses-cluster-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'clusters.json'), `${JSON.stringify(clusters, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(outDir, 'meta.json'),
    `${JSON.stringify({ checked: false, kind: 'misses-cluster' }, null, 2)}\n`,
    'utf8'
  );
  console.log(
    `Miss clusters → ${outDir} (${clusters.length} clusters, ${records.length} records)`
  );
}

/**
 * Build hashed n-gram semantic index from pack FAQ/query into pack/semantic-index.json.
 */
export async function cmdPackEmbedIndex(args: string[]): Promise<void> {
  const dir = positionalDir(args, FEEDBACK_PATH_FLAGS);
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home}`);
    process.exitCode = 1;
    return;
  }
  const files = loadPackFolderJson(home);
  const faq = (files.faq as FaqEntry[] | undefined) ?? [];
  const queries =
    (files.queries as Array<{ id: string; title: string; aliases: string[] }> | undefined) ??
    [];
  const index = buildSemanticIndex({ faq, queries });
  const packDir = join(home, 'pack');
  mkdirSync(packDir, { recursive: true });
  const outPath = join(packDir, 'semantic-index.json');
  writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(
    `Semantic index → ${outPath} (${index.docs.length} docs, dim=${index.dim})`
  );
}
