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
  writeFoldedPackDraft,
} from '@notlm-training/recalibrate';
import { buildSemanticIndex, type FaqEntry, type SemanticIndex } from '@notlm/core';
import {
  loadPackJsonFromFolder,
  resolvePackFolder,
  writeCustomSemanticFromClusters,
  writeSemanticBaseIndex,
} from '@notlm-training/author';
import { validateMissRecordList } from '@notlm/schema';
import {
  draftsDir,
  loadPackFolderJson,
  pathExists,
  resolveActivePackDir,
  resolveNotlmHome,
} from './notlmHome.js';
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

function flowStepIds(home: string, packOverride?: string): Set<string> {
  const ids = new Set<string>();
  try {
    const files = loadPackFolderJson(home, packOverride);
    const flow = files.flow;
    if (Array.isArray(flow)) {
      for (const s of flow) {
        if (s && typeof s === 'object' && typeof (s as { id?: string }).id === 'string') {
          ids.add((s as { id: string }).id);
        }
      }
    }
  } catch (err) {
    process.stderr.write(
      `[misses] flow step ids unavailable (${packOverride ?? 'default'}): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
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
  const proposedCorpus: Array<{
    utterance: string;
    expect: { stepId: string | null; rawIntent?: string };
  }> = [];
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
    // Resolve goto from rawIntent `goto:<stepId>` or when miss kind is itself a step id.
    const resolvedGoto =
      (gotoFromRaw && stepIds.has(gotoFromRaw) ? gotoFromRaw : '') ||
      (stepIds.has(kind) ? kind : '');

    if (resolvedGoto) {
      const bucket = proposedAliases[resolvedGoto] ?? [];
      if (!bucket.includes(text)) bucket.push(text);
      proposedAliases[resolvedGoto] = bucket;
      proposedCorpus.push({
        utterance: text,
        expect: { stepId: resolvedGoto },
      });
      continue;
    }

    if (kind === 'goto' || gotoFromRaw) {
      proposedCorpus.push({
        utterance: text,
        expect: { stepId: null, rawIntent: 'refuse' },
      });
      continue;
    }

    // Ambiguous / low-confidence — label kind so fold scenarios gate repair routing.
    if (kind === 'ambiguous' || kind === 'low_confidence') {
      proposedCorpus.push({
        utterance: text,
        expect: { stepId: null, rawIntent: kind },
      });
      continue;
    }

    proposedCorpus.push({
      utterance: text,
      expect: { stepId: null, rawIntent: 'refuse' },
    });
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
      unlabeledCount: 0,
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
 * Auth mirrors feedback pull: JWT → Bearer; else X-NotLM-Export-Token.
 */
export async function cmdMissesPull(args: string[]): Promise<void> {
  const url = takeFlag(args, '--url');
  if (!url) {
    console.error(
      'Usage: notlm-training misses pull --url <endpoint> [--out <path>] [--token <export|jwt>]'
    );
    process.exitCode = 1;
    return;
  }
  const outPath = takeFlag(args, '--out');
  const token =
    takeFlag(args, '--token')?.trim() ||
    (process.env.NOTLM_MISSES_TOKEN || '').trim() ||
    (process.env.NOTLM_MISSES_EXPORT_TOKEN || '').trim();
  const fetchFn = globalThis.fetch?.bind(globalThis);
  if (!fetchFn) {
    throw new Error('fetch is not available in this runtime');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    const looksLikeJwt = token.split('.').length === 3;
    if (looksLikeJwt) headers.Authorization = `Bearer ${token}`;
    else headers['X-NotLM-Export-Token'] = token;
  }
  const res = await fetchFn(url, { method: 'GET', headers });
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

  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }
  const activePack = resolveActivePackDir(home, projectRoot, resolvePackFolder);

  const raw = readFileSync(fromPath, 'utf8');
  let draft: Record<string, unknown>;
  let exchanges: ReturnType<typeof parseMissExchanges> | null = null;
  try {
    exchanges = parseMissExchanges(raw);
  } catch (err) {
    const head = raw.slice(0, 2000);
    const looksExchange = /"llmReply"\s*:|"proposed"\s*:/.test(head);
    if (args.includes('--strict') || looksExchange) {
      console.error(
        `misses draft-aliases: exchange parse failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      process.exitCode = 1;
      return;
    }
    exchanges = null;
  }
  if (exchanges?.some(isMissExchange)) {
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
    const records = parseMissRecords(raw);
    draft = draftFromMissRecords(
      records,
      flowStepIds(home, activePack)
    ) as Record<string, unknown>;
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
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const activePack = resolveActivePackDir(home, projectRoot, resolvePackFolder);
  const records = parseMissRecords(readFileSync(fromPath, 'utf8'));
  let clusters = clusterMissRecords(records);
  try {
    const files = loadPackFolderJson(home, activePack);
    const faq = (files.faq as FaqEntry[] | undefined) ?? [];
    const qRaw = files.queries;
    const queries = Array.isArray(qRaw)
      ? (qRaw as Array<{ id: string; title: string; aliases: string[] }>)
      : Array.isArray((qRaw as { queries?: unknown } | undefined)?.queries)
        ? ((qRaw as { queries: Array<{ id: string; title: string; aliases: string[] }> })
            .queries)
        : [];
    const baseRaw = files['semantic-index'];
    const semanticIndex =
      baseRaw &&
      typeof baseRaw === 'object' &&
      Array.isArray((baseRaw as { docs?: unknown }).docs) &&
      (baseRaw as { docs: unknown[] }).docs.length > 0
        ? (baseRaw as SemanticIndex)
        : buildSemanticIndex({ faq, queries });
    const customRaw = files['semantic-index.custom'];
    const semanticIndexCustom =
      customRaw &&
      typeof customRaw === 'object' &&
      Array.isArray((customRaw as { docs?: unknown }).docs)
        ? (customRaw as SemanticIndex)
        : undefined;
    clusters = annotateClustersWithPack(clusters, {
      faq,
      queries,
      semanticIndex,
      semanticIndexCustom,
      strictCustom: args.includes('--strict-custom'),
    });
  } catch (err) {
    const msg = `misses cluster: pack annotate failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    // Default fail — use --lenient to warn-only (corrupt custom layer, etc.).
    if (args.includes('--lenient')) {
      console.warn(msg);
    } else {
      console.error(msg);
      process.exitCode = 1;
      return;
    }
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

  const packDir = activePack;

  let foldDir: string | null = null;
  try {
    foldDir = writeFoldedPackDraft(home, join(outDir, 'draft.json'), { packDir });
  } catch (err) {
    console.warn(
      `Miss clusters → fold skipped: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Feed System One custom layer with cluster paraphrases (does not touch base index).
  const strictCustom = args.includes('--strict-custom');
  try {
    if (!pathExists(packDir)) {
      throw new Error(`Missing pack folder: ${packDir}`);
    }
    const custom = writeCustomSemanticFromClusters(packDir, clusters);
    console.log(
      `Miss clusters → ${outDir} (${clusters.length} clusters, ${records.length} records); custom semantic → ${custom.path} (+${custom.docsAdded} docs, ${custom.docsTotal} total)${
        foldDir ? `; folded → ${foldDir}` : ''
      }`
    );
  } catch (err) {
    console.warn(
      `Miss clusters → ${outDir}${foldDir ? `; folded → ${foldDir}` : ''} but custom semantic failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    // Soft by default so promote can continue to draft-aliases; --strict-custom for CI.
    if (strictCustom) process.exitCode = 1;
  }
}

/**
 * Build hashed n-gram **base** semantic index from pack FAQ/query →
 * `pack/semantic-index.json`.
 *
 * Never writes `semantic-index.custom.json` (host/training overlay). Runtime
 * combines both layers at live retrieve so regenerating base is safe.
 */
export async function cmdPackEmbedIndex(args: string[]): Promise<void> {
  const dir = positionalDir(args, FEEDBACK_PATH_FLAGS);
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home}`);
    process.exitCode = 1;
    return;
  }
  const packDir = resolveActivePackDir(home, projectRoot, resolvePackFolder);
  if (!pathExists(packDir)) {
    console.error(`Missing pack folder under ${home}`);
    process.exitCode = 1;
    return;
  }
  const pack = loadPackJsonFromFolder(packDir);
  const index = writeSemanticBaseIndex(packDir, pack);
  const outPath = join(packDir, 'semantic-index.json');
  const customPath = join(packDir, 'semantic-index.custom.json');
  const customNote = pathExists(customPath)
    ? ' (left semantic-index.custom.json untouched)'
    : ' (optional overlay: pack/semantic-index.custom.json)';
  console.log(
    `Semantic base index → ${outPath} (${index.docs.length} docs, dim=${index.dim})${customNote}`
  );
}
