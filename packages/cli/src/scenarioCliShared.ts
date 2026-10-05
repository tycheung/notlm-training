import {
  buildContextTreePlan,
  llmBatchGenerator,
  splitContextBatchGenerator,
  type BatchGenerator,
  type ScenarioCandidate,
  type ScenarioGenerateMode,
} from '@notlm-training/author';
import type { IntentParsePack } from '@notlm/core';
import { createProviderFromEnv } from '@notlm-training/llm';
import { join } from 'node:path';
import {
  ensureDir,
  loadPackFolderJson,
  pathExists,
  readJsonFile,
  resolveNotlmHome,
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

function requireNotlmHome(args: string[]): string | null {
  const dir = positionalDir(args);
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return null;
  }
  return home;
}

export type ScenarioPackContext = {
  files: Record<string, unknown>;
  productBlurb?: string;
  pack: IntentParsePack;
  prior: ScenarioCandidate[];
  inventory?: unknown;
  structuredDraft?: unknown;
  mode: ScenarioGenerateMode;
  useFixture: boolean;
};

/** Load pack + optional home JSON; returns null after setting exitCode if pack invalid. */
function loadScenarioPackContext(home: string, args: string[]): ScenarioPackContext | null {
  const files = loadPackFolderJson(home);
  const productBlurb = resolveProductBlurb(args, files);
  const pack = asIntentPack(files);
  if (!pack) {
    console.error('pack/ requires flow.json and intents.json');
    process.exitCode = 1;
    return null;
  }
  const prior = loadPriorCandidates(home);
  const inventory = pathExists(join(home, 'inventory.json'))
    ? readJsonFile(join(home, 'inventory.json'))
    : undefined;
  const structuredDraft = pathExists(join(home, 'structured-draft.json'))
    ? readJsonFile(join(home, 'structured-draft.json'))
    : undefined;
  const useFixture = hasFlag(args, '--fixture') || process.env.NOTLM_SATURATE_FIXTURE === '1';
  const mode = resolveGenerateMode(args);
  return {
    files,
    productBlurb,
    pack,
    prior,
    inventory,
    structuredDraft,
    mode,
    useFixture,
  };
}

/** Fixture vs split-context vs plain LLM batch generator; writes context-tree.json. */
function installScenarioGeneratePipeline(
  home: string,
  ctx: ScenarioPackContext,
  args: string[]
): { generateBatch: BatchGenerator; splitNote: string } {
  const fixtureSeed = ctx.mode === 'user-ask' ? USER_ASK_FIXTURE_SEED : FIXTURE_SEED;
  const wantSplit = ctx.mode === 'flow' && !hasFlag(args, '--no-split-context');
  const treePlan = buildContextTreePlan(ctx.pack);
  let generateBatch: BatchGenerator;
  let splitNote = 'off';
  if (ctx.useFixture) {
    generateBatch = fixtureBatchGenerator(fixtureSeed);
    splitNote = 'fixture';
  } else if (wantSplit) {
    const split = splitContextBatchGenerator({
      pack: ctx.pack,
      provider: createProviderFromEnv(),
      inventory: ctx.inventory,
      structuredDraft: ctx.structuredDraft,
      productBlurb: ctx.productBlurb,
      enabled: true,
    });
    generateBatch = split.generateBatch;
    splitNote = split.plan.muddy
      ? `auto(${split.plan.modes.length} modes, ${split.plan.sharedPhraseCount} shared phrases)`
      : 'auto(clean)';
  } else {
    generateBatch = llmBatchGenerator({
      provider: createProviderFromEnv(),
      flowSteps: ctx.files.flow,
      intents: ctx.files.intents,
      inventory: ctx.inventory,
      structuredDraft: ctx.structuredDraft,
      productBlurb: ctx.productBlurb,
      mode: ctx.mode,
    });
  }
  ensureDir(saturationDir(home));
  writeJsonFile(join(saturationDir(home), 'context-tree.json'), {
    updatedAt: new Date().toISOString(),
    ...treePlan,
    splitNote,
  });
  return { generateBatch, splitNote };
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
  installScenarioGeneratePipeline,
  loadPriorCandidates,
  loadScenarioPackContext,
  parseFlag,
  parseForceCount,
  positionalDir,
  requireNotlmHome,
  resolveGenerateMode,
  resolveProductBlurb,
  saturationDir,
  stamp,
  writeSaturationArtifacts,
};

