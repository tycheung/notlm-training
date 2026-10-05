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

export function takeFlag(args: string[], name: string): string | undefined {
  const eq = args.findIndex((a) => a.startsWith(`${name}=`));
  if (eq >= 0) return args[eq]!.slice(name.length + 1);
  const idx = args.findIndex((a) => a === name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

export function usage(): void {
  console.log(`Usage (training modes):
  notlm-training auto [dir] [--per-lane=5000] [--pass-rate=0.999] [--max-rounds=20]
                        [--lanes=faq,goto,…] [--fixture] [--no-write]
    # System One: LLM preset pre-prompts → N×13 lanes → score → patch pack → iterate
  notlm-training auto ranker [dir]   # explicit pack/ranker.json retrain

  notlm-training feedback pull|draft|fold|metrics|accept|run|conversations|misses …
  notlm-training feedback conversations pull|analyze …
  # legacy: exchanges pull|draft|fold ; conversations analyze

Authoring (not training modes):
  notlm-training map|tune|prepare|inventory|extract|trace|annotate|jobs|checklist|dag|talk|pack …
  notlm-training extract host <hostAppRoot>   # workshop → host .notlm/pack (deploy SoT)
  notlm-training laya convert|train [dir] [--out=…] [--mode=full|light] [--dry-run]

Legacy aliases (deprecated): sharpen, train auto, exchanges *, conversations *, misses *, ranker train

Pack quality gates stay on operating notlmCLI:
  notlmCLI validate | intents check | ranker check
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
    console.error('Usage: notlm-training exchanges draft --from <file> [dir]');
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
  const home = join(dir, '.notlm');
  if (!existsSync(home)) {
    mkdirSync(join(home, 'drafts'), { recursive: true });
  }
  const exchanges = loadExchangesFromRaw(readFileSync(fromPath, 'utf8'));
  const outDir = writeExchangeDraft(home, exchanges);
  console.log(
    `Exchange draft → ${outDir} (${exchanges.length} records) — next: exchanges fold, review, set meta.checked=true, pack accept, then notlmCLI intents check`
  );
}

export async function cmdFold(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: notlm-training exchanges fold --from <exchanges-*/draft.json> [dir]'
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
  const home = join(dir, '.notlm');
  if (!existsSync(home)) {
    mkdirSync(join(home, 'drafts'), { recursive: true });
  }
  const outDir = writeFoldedPackDraft(home, fromPath);
  console.log(
    `Folded pack draft → ${outDir} — review, set meta.checked=true, pack accept, then notlmCLI intents check`
  );
}

export async function cmdMetrics(args: string[]): Promise<void> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: notlm-training metrics --from <exchanges.json> [--misses <misses.json>]'
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
    if (cmd === 'auto') {
      const { cmdAuto, cmdAutoRanker } = await import('./cmdAuto.js');
      if (!sub || sub.startsWith('--') || /^\d/.test(sub) || sub.includes('/') || sub.includes('\\')) {
        await cmdAuto(argv.slice(1));
      } else if (sub === 'ranker') await cmdAutoRanker(rest);
      else if (sub === 'pause' || sub === 'resume' || sub === 'stop') {
        console.error(
          `Removed: \`auto ${sub}\` belonged to the old growth loop. Use \`auto --max-rounds=N\` instead.`
        );
        process.exitCode = 1;
      } else await cmdAuto(argv.slice(1));
      return;
    }
    if (cmd === 'feedback') {
      const { cmdFeedback } = await import('./cmdFeedback.js');
      await cmdFeedback(argv.slice(1));
      return;
    }
    if (cmd === 'sharpen') {
      const { cmdSharpen } = await import('./cmdSharpen.js');
      await cmdSharpen(argv.slice(1));
      return;
    }
    // Legacy aliases → new modes
    if (cmd === 'train' && (sub === 'auto' || sub === 'pause' || sub === 'resume' || sub === 'stop')) {
      if (sub === 'auto') {
        console.warn('[deprecated] use `notlm-training auto` instead of `train auto`');
        const { cmdAuto } = await import('./cmdAuto.js');
        await cmdAuto(rest);
      } else {
        console.error(
          `Removed: \`train ${sub}\` belonged to the old growth loop. Use \`notlm-training auto --max-rounds=N\` instead.`
        );
        process.exitCode = 1;
      }
      return;
    }
    if (cmd === 'exchanges' && sub === 'pull') {
      console.warn('[deprecated] use `notlm-training feedback pull`');
      await cmdPull(rest);
    } else if (cmd === 'exchanges' && sub === 'draft') {
      console.warn('[deprecated] use `notlm-training feedback draft`');
      await cmdDraft(rest);
    } else if (cmd === 'exchanges' && sub === 'fold') {
      console.warn('[deprecated] use `notlm-training feedback fold`');
      await cmdFold(rest);
    } else if (cmd === 'conversations' && sub === 'pull') {
      console.warn('[deprecated] use `notlm-training feedback conversations pull`');
      const { cmdConversationsPull } = await import('./cmdConversations.js');
      await cmdConversationsPull(rest);
    } else if (cmd === 'conversations' && sub === 'analyze') {
      console.warn('[deprecated] use `notlm-training feedback conversations analyze`');
      const { cmdConversationsAnalyze } = await import('./cmdConversations.js');
      await cmdConversationsAnalyze(rest);
    } else if (cmd === 'metrics') {
      console.warn('[deprecated] use `notlm-training feedback metrics`');
      await cmdMetrics(argv.slice(1));
    } else if (cmd === 'help' || cmd === '--help' || !cmd) usage();
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
