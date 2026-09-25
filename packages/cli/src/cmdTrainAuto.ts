import { join } from 'node:path';
import {
  mergeAliasesIntoIntents,
  resolveTrainAutoConfig,
  runTrainAuto,
  writeAcceptDraft,
  writeControl,
  ensureTrainAutoDir,
  deriveWindowSize,
  makeEvalItem,
  type PackIO,
} from '@uipilot/author';
import type { IntentParsePack } from '@uipilot/core';
import { createProviderFromEnv } from '@uipilot/llm';
import { loadPackFolderJson, pathExists, resolveUipilotHome } from './uipilotHome.js';
import { cmdPackAccept } from './commands.js';

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
}

function positionalDir(args: string[]): string | undefined {
  for (const a of args) {
    if (a.startsWith('--')) continue;
    if (/^\d+(\.\d+)?$/.test(a)) continue;
    return a;
  }
  return undefined;
}

function asIntentPack(files: Record<string, unknown>): IntentParsePack | null {
  const flow = files.flow;
  const intents = files.intents as
    | { aliases?: Record<string, string[]>; meta?: string[] }
    | undefined;
  if (!Array.isArray(flow) || !intents) return null;
  return {
    steps: flow as IntentParsePack['steps'],
    aliases: intents.aliases ?? {},
    meta: intents.meta,
    faq: Array.isArray(files.faq) ? (files.faq as IntentParsePack['faq']) : undefined,
  };
}

function rebuildPackIo(home: string): PackIO {
  return {
    home,
    loadPack: () => loadPackFolderJson(home),
    asIntentPack,
    acceptIntentsMerge: async (aliasesDelta, scenarios) => {
      const files = loadPackFolderJson(home);
      const intents = files.intents as {
        aliases?: Record<string, string[]>;
        meta?: string[];
        [k: string]: unknown;
      };
      if (!intents) return { ok: false, errors: ['missing intents.json'] };
      const merged = mergeAliasesIntoIntents(intents, aliasesDelta);
      const existingScenarios = Array.isArray(files.scenarios)
        ? (files.scenarios as unknown[])
        : [];
      const nextScenarios = scenarios
        ? [...existingScenarios, ...scenarios]
        : existingScenarios;

      const pack = asIntentPack({ ...files, intents: merged });
      if (!pack) return { ok: false, errors: ['invalid pack after merge'] };

      const errors: string[] = [];
      for (const [stepId, phrases] of Object.entries(aliasesDelta)) {
        for (const utterance of phrases) {
          const item = makeEvalItem(utterance, { stepId }, pack);
          if (!item.passed) {
            errors.push(item.note ?? `${utterance} ↛ ${stepId}`);
          }
        }
      }
      if (errors.length) {
        return { ok: false, errors: errors.slice(0, 12) };
      }

      const draftId = `train-auto-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      writeAcceptDraft({
        home,
        draftId,
        intents: merged,
        scenarios: nextScenarios,
      });
      const { projectRoot } = resolveUipilotHome(join(home, '..'));
      await cmdPackAccept(draftId, projectRoot);
      return { ok: true, draftId };
    },
    retrainRanker: async () => {
      try {
        const { cmdRankerTrain } = await import('./cmdRanker.js');
        await cmdRankerTrain([join(home, '..')]);
        return { ok: true, detail: 'pack/ranker.json' };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export async function cmdTrainAuto(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home } = resolveUipilotHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing UiPilot home: ${home}`);
    process.exitCode = 1;
    return;
  }

  const passRate = Number(parseFlag(args, '--pass-rate') ?? '0.99');
  const confidence = Number(parseFlag(args, '--confidence') ?? '0.99');
  const windowRaw = parseFlag(args, '--window');
  const window = windowRaw ? Number(windowRaw) : deriveWindowSize(passRate, confidence);
  const maxCpu = Number(parseFlag(args, '--max-cpu') ?? '0.8');
  const maxRam = Number(parseFlag(args, '--max-ram') ?? '0.8');
  const workersRaw = parseFlag(args, '--workers');
  const maxIterRaw = parseFlag(args, '--max-iterations');
  const fixture =
    hasFlag(args, '--fixture') ||
    process.env.UIPILOT_SATURATE_FIXTURE === '1' ||
    process.env.UIPILOT_TRAIN_AUTO_FIXTURE === '1';
  const resume = hasFlag(args, '--resume');

  const config = resolveTrainAutoConfig({
    passRate,
    confidence,
    window,
    maxCpu,
    maxRam,
    workers: workersRaw ? Number(workersRaw) : undefined,
    fixture,
    resume,
    maxIterations: maxIterRaw ? Number(maxIterRaw) : fixture ? 40 : 10_000,
  });

  let provider = null;
  if (!fixture) {
    try {
      provider = createProviderFromEnv();
    } catch (err) {
      console.error(
        err instanceof Error
          ? err.message
          : `${String(err)} — use --fixture or set UIPILOT_LLM_*`
      );
      process.exitCode = 1;
      return;
    }
  }

  console.log(
    `train auto → ${home} pass=${config.passRate} conf=${config.confidence} window=${config.window} workers=${config.workers} fixture=${config.fixture}`
  );

  const report = await runTrainAuto({
    home,
    packIo: rebuildPackIo(home),
    provider,
    config,
    pollMs: fixture ? 10 : 400,
  });

  console.log(
    `Done: reason=${report.stoppedReason} iters=${report.iterations} rolling=${report.rolling.lastPassRate.toFixed(4)} met=${report.rolling.met}`
  );
  console.log(`Report: ${join(home, 'train-auto', 'report.json')}`);
  if (
    report.stoppedReason === 'error' ||
    (report.stoppedReason === 'max-iterations' && !report.rolling.met && !fixture)
  ) {
    process.exitCode = 1;
  }
}

export async function cmdTrainPause(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home } = resolveUipilotHome(dir);
  const d = ensureTrainAutoDir(home);
  writeControl(d, 'paused', 'train pause');
  console.log(`Paused → ${join(d, 'control.json')}`);
}

export async function cmdTrainResume(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const rest = args.filter((a) => a.startsWith('--') && a !== '--resume');
  await cmdTrainAuto([...(dir ? [dir] : []), '--resume', ...rest]);
}

export async function cmdTrainStop(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home } = resolveUipilotHome(dir);
  const d = ensureTrainAutoDir(home);
  writeControl(d, 'stop', 'train stop');
  console.log(`Stop requested → ${join(d, 'control.json')}`);
}
