#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateMissExchangeList } from '@notlm/schema';
import {
  computeTrafficMetrics,
  loadExchangesFromJson,
  loadExchangesFromRaw,
  parseMissRecords,
  writeExchangeDraft,
  writeFoldedPackDraft,
} from '@notlm-training/recalibrate';
import { resolvePackFolder } from '@notlm-training/author';
import { takeFlag, resolveDirAfterFromFlag } from './cliFlags.js';
import { resolveActivePackDir, resolveNotlmHome } from './notlmHome.js';

export { takeFlag } from './cliFlags.js';

export function usage(): void {
  console.log(`Usage — two entry points:

  notlm-training train [dir] [--fixture] [--per-lane=N] [--pass-rate=0.999]
                       [--skip-auto|--skip-e2e] [--laya=1] [--force-ranker]
    # Grow pack: capability stress (auto) → e2eauto → embed/ranker on drift
    # Laya only when --laya=1. Custom semantic overlay never overwritten.

  notlm-training feedback [dir] [--url=…] [--from=misses.json] [--token=…]
    # Prod promote: pull misses → cluster → draft-aliases (+ custom semantic)
    # Post (embed/ranker[/laya]) runs on feedback accept; optional --post

Post steps: rebuild semantic-index.json only on source drift;
retrain ranker.json when aliases/corpus digest drifts (or --force-ranker);
stamp digests only on success. train stops on phase failure unless --continue-on-error.

Legacy aliases (still work):
  auto | e2eauto | auto ranker | misses … | pack embed-index | laya … | ranker train
  feedback pull|draft|fold|accept|run|conversations|misses|embed-index …

Authoring:
  map|tune|prepare|inventory|extract|scenarios|pack author|accept|talk …

Gates (notlmCLI): validate | intents check | ranker check
`);
}

export async function cmdPull(args: string[]): Promise<void> {
  const url = takeFlag(args, '--url');
  if (!url) {
    console.error(
      'Usage: notlm-training feedback pull --url <endpoint> [--out <path>] [--token <export|jwt>]'
    );
    process.exitCode = 1;
    return;
  }
  const outPath = takeFlag(args, '--out');
  const token =
    takeFlag(args, '--token')?.trim() ||
    (process.env.NOTLM_MISSES_TOKEN || '').trim() ||
    (process.env.NOTLM_MISSES_EXPORT_TOKEN || '').trim();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) {
    // Machine promote uses the shared export secret — do NOT also send it as
    // Authorization Bearer (optional JWT auth would 401 on a non-JWT token).
    const looksLikeJwt = token.split('.').length === 3;
    if (looksLikeJwt) headers.Authorization = `Bearer ${token}`;
    else headers['X-NotLM-Export-Token'] = token;
  }
  const res = await fetch(url, { headers });
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
    console.error('Usage: notlm-training feedback draft --from <file> [dir]');
    process.exitCode = 1;
    return;
  }
  const dir = resolveDirAfterFromFlag(args);
  const { home } = resolveNotlmHome(dir);
  if (!existsSync(home)) {
    mkdirSync(join(home, 'drafts'), { recursive: true });
  }
  const exchanges = loadExchangesFromRaw(readFileSync(fromPath, 'utf8'));
  const outDir = writeExchangeDraft(home, exchanges);
  console.log(
    `Exchange draft → ${outDir} (${exchanges.length} records) — next: feedback fold, review, set meta.checked=true, pack accept, then notlmCLI intents check`
  );
}

export async function cmdFold(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: notlm-training feedback fold --from <exchanges-*/draft.json> [dir]'
    );
    process.exitCode = 1;
    return;
  }
  const dir = resolveDirAfterFromFlag(args);
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!existsSync(home)) {
    mkdirSync(join(home, 'drafts'), { recursive: true });
  }
  const packDir = resolveActivePackDir(home, projectRoot, resolvePackFolder);
  const outDir = writeFoldedPackDraft(home, fromPath, { packDir });
  console.log(
    `Folded pack draft → ${outDir} — review, set meta.checked=true, pack accept, then notlmCLI intents check`
  );
}

export async function cmdMetrics(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: notlm-training feedback metrics --from <exchanges.json> [--misses <misses.json>]'
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
    if (cmd === 'train') {
      const { cmdTrain } = await import('./cmdTrain.js');
      await cmdTrain(argv.slice(1));
      return;
    }
    if (cmd === 'auto') {
      const { cmdAuto, cmdAutoRanker } = await import('./cmdAuto.js');
      if (!sub || sub.startsWith('--') || /^\d/.test(sub) || sub.includes('/') || sub.includes('\\')) {
        console.warn('hint: prefer `notlm-training train` (auto + e2eauto + drift post)');
        await cmdAuto(argv.slice(1));
      } else if (sub === 'ranker') await cmdAutoRanker(rest);
      else if (sub === 'pause' || sub === 'resume' || sub === 'stop') {
        console.error(
          `Removed: \`auto ${sub}\` belonged to the old growth loop. Use \`train --max-rounds=N\` instead.`
        );
        process.exitCode = 1;
      } else await cmdAuto(argv.slice(1));
      return;
    }
    if (cmd === 'e2eauto') {
      console.warn('hint: prefer `notlm-training train` (includes e2eauto)');
      const { cmdE2eAuto } = await import('./cmdE2eAuto.js');
      await cmdE2eAuto(argv.slice(1));
      return;
    }
    if (cmd === 'feedback') {
      const { cmdFeedback } = await import('./cmdFeedback.js');
      await cmdFeedback(argv.slice(1));
      return;
    }
    if (cmd === 'help' || cmd === '--help' || !cmd) usage();
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
