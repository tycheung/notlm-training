#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateMissExchangeList } from '@uipilot/schema';
import {
  computeTrafficMetrics,
  loadExchangesFromJson,
  loadExchangesFromRaw,
  parseMissRecords,
  writeExchangeDraft,
  writeFoldedPackDraft,
} from '@uipilot-training/recalibrate';

export function takeFlag(args: string[], name: string): string | undefined {
  const eq = args.findIndex((a) => a.startsWith(`${name}=`));
  if (eq >= 0) return args[eq]!.slice(name.length + 1);
  const idx = args.findIndex((a) => a === name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

export function usage(): void {
  console.log(`Usage:
  uipilot-training exchanges pull --url <endpoint> [--out <path>]
  uipilot-training exchanges draft --from <file.json|jsonl> [dir]
  uipilot-training exchanges fold --from <draft.json> [dir]
  uipilot-training metrics --from <exchanges.json> [--misses <misses.json>]

  uipilot-training conversations pull --url <endpoint> [--out <path>]
  uipilot-training conversations analyze --from <conv.json> [dir] [--mode=review|auto] [--fixture]

  uipilot-training map|tune|prepare [dir] …
  uipilot-training scenarios … | pack author|accept | intents tune | ranker train
  uipilot-training inventory|extract|trace|annotate|jobs|checklist|dag|talk|misses …

  Pack quality gates stay on operating uipilotCLI:
  uipilotCLI validate | intents check | ranker check
`);
}

export async function cmdPull(args: string[]): Promise<void> {
  const url = takeFlag(args, '--url');
  if (!url) {
    console.error('Usage: uipilot-training exchanges pull --url <endpoint> [--out <path>]');
    process.exitCode = 1;
    return;
  }
  const outPath = takeFlag(args, '--out');
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as unknown;
  let exchanges;
  const schema = validateMissExchangeList(data);
  if (schema.ok) {
    exchanges = loadExchangesFromJson(data);
  } else if (Array.isArray(data)) {
    exchanges = loadExchangesFromJson(
      data.filter(
        (row) =>
          row &&
          typeof row === 'object' &&
          typeof (row as { llmReply?: unknown }).llmReply === 'string'
      )
    );
  } else {
    throw new Error(schema.errors.join('\n'));
  }
  const payload = `${JSON.stringify(exchanges, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, payload, 'utf8');
    console.log(`Wrote ${exchanges.length} exchanges → ${outPath}`);
  } else {
    process.stdout.write(payload);
  }
}

export async function cmdDraft(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error('Usage: uipilot-training exchanges draft --from <file> [dir]');
    process.exitCode = 1;
    return;
  }
  const skip = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--from') {
      skip.add(a);
      if (args[i + 1]) skip.add(args[i + 1]!);
    } else if (a.startsWith('--from=')) skip.add(a);
  }
  const dir = args.find((a) => !a.startsWith('-') && !skip.has(a)) ?? process.cwd();
  const home = join(dir, '.uipilot');
  if (!existsSync(home)) {
    mkdirSync(join(home, 'drafts'), { recursive: true });
  }
  const exchanges = loadExchangesFromRaw(readFileSync(fromPath, 'utf8'));
  const outDir = writeExchangeDraft(home, exchanges);
  console.log(
    `Exchange draft → ${outDir} (${exchanges.length} records) — next: exchanges fold, review, set meta.checked=true, pack accept, then uipilotCLI intents check`
  );
}

export async function cmdFold(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: uipilot-training exchanges fold --from <exchanges-*/draft.json> [dir]'
    );
    process.exitCode = 1;
    return;
  }
  const skip = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--from') {
      skip.add(a);
      if (args[i + 1]) skip.add(args[i + 1]!);
    } else if (a.startsWith('--from=')) skip.add(a);
  }
  const dir = args.find((a) => !a.startsWith('-') && !skip.has(a)) ?? process.cwd();
  const home = join(dir, '.uipilot');
  if (!existsSync(home)) {
    mkdirSync(join(home, 'drafts'), { recursive: true });
  }
  const outDir = writeFoldedPackDraft(home, fromPath);
  console.log(
    `Folded pack draft → ${outDir} — review, set meta.checked=true, pack accept, then uipilotCLI intents check`
  );
}

export async function cmdMetrics(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: uipilot-training metrics --from <exchanges.json> [--misses <misses.json>]'
    );
    process.exitCode = 1;
    return;
  }
  const missesPath = takeFlag(args, '--misses');
  const exchanges = loadExchangesFromRaw(readFileSync(fromPath, 'utf8'));
  const misses = missesPath
    ? parseMissRecords(readFileSync(missesPath, 'utf8'))
    : undefined;
  const metrics = computeTrafficMetrics({ exchanges, misses });
  console.log(JSON.stringify(metrics, null, 2));
}

export async function runCli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const sub = argv[1];
  const rest = argv.slice(2);
  try {
    if (cmd === 'exchanges' && sub === 'pull') await cmdPull(rest);
    else if (cmd === 'exchanges' && sub === 'draft') await cmdDraft(rest);
    else if (cmd === 'exchanges' && sub === 'fold') await cmdFold(rest);
    else if (cmd === 'conversations' && sub === 'pull') {
      const { cmdConversationsPull } = await import('./cmdConversations.js');
      await cmdConversationsPull(rest);
    } else if (cmd === 'conversations' && sub === 'analyze') {
      const { cmdConversationsAnalyze } = await import('./cmdConversations.js');
      await cmdConversationsAnalyze(rest);
    } else if (cmd === 'metrics') await cmdMetrics(argv.slice(1));
    else if (cmd === 'help' || cmd === '--help' || !cmd) usage();
    else {
      const { isFatCommand, runFatCli } = await import('./fatDispatch.js');
      if (isFatCommand(cmd, sub)) {
        await runFatCli(argv);
        return;
      }
      console.error(`Unknown command: ${cmd} ${sub ?? ''}`.trim());
      usage();
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void runCli(process.argv.slice(2));
}
