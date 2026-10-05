import {
  type ScenarioCandidate,
  type ScenarioGenerateMode,
} from '@notlm-training/author';
import type { IntentParsePack } from '@notlm/core';
import { join } from 'node:path';
import {
  ensureDir,
  pathExists,
  readJsonFile,
  writeJsonFile,
} from './notlmHome.js';
import { hasFlag, parseFlag, positionalDir } from './cliFlags.js';

function saturationDir(home: string): string {
  return join(home, 'saturation');
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function asIntentPack(files: Record<string, unknown>): IntentParsePack | null {
  const flow = files.flow;
  const intents = files.intents as { aliases?: Record<string, string[]>; meta?: string[] } | undefined;
  if (!Array.isArray(flow) || !intents) return null;
  return {
    steps: flow as IntentParsePack['steps'],
    aliases: intents.aliases ?? {},
    meta: intents.meta,
  };
}

/** npm often strips `--batch 5`; accept leftover bare integers as batch then maxBatches. */
function bareNumbers(args: string[]): number[] {
  return args.filter((a) => /^\d+$/.test(a)).map(Number);
}

/** `--force=N` / `--hard=N` — hard augment count (ignore similarity). */
function parseForceCount(args: string[]): number | undefined {
  const raw = parseFlag(args, '--force') ?? parseFlag(args, '--hard');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function loadPriorCandidates(home: string): ScenarioCandidate[] {
  const path = join(saturationDir(home), 'candidates.json');
  if (!pathExists(path)) return [];
  const data = readJsonFile<{ candidates?: ScenarioCandidate[] }>(path);
  return Array.isArray(data.candidates) ? data.candidates : [];
}

function writeSaturationArtifacts(
  home: string,
  candidates: ScenarioCandidate[],
  report: unknown,
  batchId?: string,
  batchSlice?: ScenarioCandidate[]
): void {
  const sat = saturationDir(home);
  ensureDir(sat);
  writeJsonFile(join(sat, 'candidates.json'), {
    updatedAt: new Date().toISOString(),
    candidates,
  });
  writeJsonFile(join(sat, 'novelty-report.json'), report);
  if (batchId && batchSlice) {
    const batches = join(sat, 'batches');
    ensureDir(batches);
    writeJsonFile(join(batches, `${batchId}.json`), {
      batchId,
      candidates: batchSlice,
    });
  }
}

function appendChecklist(home: string, items: Array<Record<string, unknown>>): void {
  const path = join(home, 'checklist.json');
  const current = pathExists(path)
    ? readJsonFile<{ items?: unknown[] }>(path)
    : { items: [] };
  const list = Array.isArray(current.items) ? [...current.items] : [];
  list.push(...items);
  writeJsonFile(path, { items: list });
}

/** Shared fixture utterances for --fixture / CI (no LLM). */
const FIXTURE_SEED = [
  'open a fresh grocery list for me',
  'toss eggs onto the list',
  'completely unrelated astronomy question',
  'finish the first incomplete todo',
  "what should I do next in this app",
] as const;

const USER_ASK_FIXTURE_SEED = [
  'is this app free to use',
  'how do I share my list with my partner',
  'can I use this offline on my phone',
  'where did my todos go after refresh',
  'does it sync across devices',
  'who can see my shopping lists',
  'why cant i add an item yet',
  'is there a dark mode',
] as const;

function resolveProductBlurb(
  args: string[],
  files: Record<string, unknown>
): string | undefined {
  const fromFlag = parseFlag(args, '--blurb')?.trim();
  if (fromFlag) return fromFlag;
  const config = files.config as
    | { author?: { productBlurb?: string; blurb?: string } }
    | undefined;
  const fromConfig =
    config?.author?.productBlurb?.trim() || config?.author?.blurb?.trim();
  return fromConfig || undefined;
}

function resolveGenerateMode(args: string[]): ScenarioGenerateMode {
  const raw = (parseFlag(args, '--mode') ?? '').trim().toLowerCase();
  if (raw === 'user-ask' || raw === 'ask' || raw === 'blurb') return 'user-ask';
  if (hasFlag(args, '--user-ask')) return 'user-ask';
  return 'flow';
}

/** Fixture generator: decreasing novelty so saturate can plateau without LLM. */
function fixtureBatchGenerator(
  seed: readonly string[] = FIXTURE_SEED
): (ctx: {
  batchIndex: number;
  batchSize: number;
  priorUtterances: string[];
}) => Promise<Array<{ id?: string; utterance: string }>> {
  return async ({ batchIndex, batchSize, priorUtterances }) => {
    if (batchIndex === 0) {
      return Array.from({ length: batchSize }, (_, i) => ({
        id: `fix-${i}`,
        utterance:
          seed[i % seed.length]! +
          (i >= seed.length ? ` pad-${i}` : ''),
      }));
    }
    const pool = priorUtterances.length > 0 ? priorUtterances : [...seed];
    return Array.from({ length: batchSize }, (_, i) => ({
      id: `fix-r${batchIndex}-${i}`,
      utterance: pool[i % pool.length]!,
    }));
  };
}

export {
  FIXTURE_SEED,
  USER_ASK_FIXTURE_SEED,
  appendChecklist,
  asIntentPack,
  bareNumbers,
  fixtureBatchGenerator,
  hasFlag,
  loadPriorCandidates,
  parseFlag,
  parseForceCount,
  positionalDir,
  resolveGenerateMode,
  resolveProductBlurb,
  saturationDir,
  stamp,
  writeSaturationArtifacts,
};

