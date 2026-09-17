import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeMissRecordList, parseMissRecords } from '@uipilot/core';
import { validateMissRecordList } from '@uipilot/schema';
import { draftsDir, pathExists, resolveUipilotHome } from './uipilotHome.js';

function takeFlag(args: string[], name: string): string | undefined {
  const eq = args.findIndex((a) => a.startsWith(`${name}=`));
  if (eq >= 0) return args[eq]!.slice(name.length + 1);
  const idx = args.findIndex((a) => a === name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function positionalDir(args: string[]): string | undefined {
  const skip = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--from' || a === '--out' || a === '--url') {
      skip.add(a);
      if (args[i + 1]) skip.add(args[i + 1]!);
    } else if (
      a.startsWith('--from=') ||
      a.startsWith('--out=') ||
      a.startsWith('--url=')
    ) {
      skip.add(a);
    }
  }
  return args.find((a) => !a.startsWith('-') && !skip.has(a));
}

function writeMissDump(records: ReturnType<typeof parseMissRecords>, outPath?: string): void {
  const payload = `${JSON.stringify(records, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, payload, 'utf8');
    console.log(`Wrote ${records.length} miss records → ${outPath}`);
  } else {
    process.stdout.write(payload);
  }
}

/** Export miss records from a JSON/JSONL dump (e.g. localStorage snapshot). */
export async function cmdMissesExport(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error('Usage: uipilot-training misses export --from <file.json|jsonl> [--out <path>]');
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
    console.error('Usage: uipilot-training misses pull --url <endpoint> [--out <path>]');
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
  const dir = positionalDir(args);
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: uipilot-training misses draft-aliases --from <file.json|jsonl> [dir]'
    );
    process.exitCode = 1;
    return;
  }

  const { home } = resolveUipilotHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing UiPilot home: ${home} (run uipilotCLI init)`);
    process.exitCode = 1;
    return;
  }

  const records = parseMissRecords(readFileSync(fromPath, 'utf8'));
  const byKind = new Map<string, string[]>();
  for (const r of records) {
    const text = (r.text ?? '').trim();
    if (!text) continue;
    const list = byKind.get(r.kind) ?? [];
    if (!list.includes(text)) list.push(text);
    byKind.set(r.kind, list);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(draftsDir(home), `misses-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const draft = {
    note: 'Human-review: fold unique miss texts into intents aliases / corpus, then delete.',
    counts: Object.fromEntries([...byKind.entries()].map(([k, v]) => [k, v.length])),
    byKind: Object.fromEntries(byKind),
    records,
  };
  writeFileSync(join(outDir, 'draft.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  console.log(`Miss draft → ${outDir} (${records.length} records)`);
}
