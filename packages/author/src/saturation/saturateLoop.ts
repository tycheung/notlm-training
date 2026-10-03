import type { IntentParsePack } from '@notlm/core';
import type { LlmProvider } from '@notlm/llm';
import { generateScenarioCandidates } from './generateCandidates.js';
import {
  buildNoveltyReport,
  scoreBatchAgainstPrior,
  updatePlateauState,
} from './novelty.js';
import { parseSignature } from './parseSignatureNovelty.js';
import {
  buildContextTreePlan,
  packSliceForMode,
  pickContextMode,
} from './contextTree.js';
import type {
  NoveltyReport,
  PlateauConfig,
  ScenarioCandidate,
  StopReason,
} from './types.js';
import { DEFAULT_PLATEAU_CONFIG } from './types.js';

export type SaturateLoopResult = {
  plateau: boolean;
  noLiftStop: boolean;
  report: NoveltyReport;
  candidates: ScenarioCandidate[];
  batchesRun: number;
  stopReason: StopReason;
};

export type BatchGenerator = (ctx: {
  batchIndex: number;
  batchSize: number;
  priorUtterances: string[];
}) => Promise<Array<{ id?: string; utterance: string }>>;

/**
 * Generate → score → accumulate until classic plateau, no-lift stop (5×100),
 * or maxBatches. `generateBatch` may wrap LLM or a fixture for tests.
 */
export async function runSaturationLoop(input: {
  pack: IntentParsePack;
  prior?: ScenarioCandidate[];
  batchSize: number;
  maxBatches: number;
  config?: Partial<PlateauConfig>;
  generateBatch: BatchGenerator;
}): Promise<SaturateLoopResult> {
  const config = { ...DEFAULT_PLATEAU_CONFIG, ...input.config };
  const candidates: ScenarioCandidate[] = [...(input.prior ?? [])];
  const batchSummaries = [];
  let consecutiveLow = 0;
  let consecutiveNoLift = 0;
  let plateau = false;
  let noLiftStop = false;
  let stopReason: StopReason = 'max-batches';
  let batchesRun = 0;

  for (let i = 0; i < input.maxBatches; i++) {
    const priorUtterances = candidates.map((c) => c.utterance);
    const priorSignatures = candidates.map(
      (c) => c.parseSignature ?? parseSignature(c.utterance, input.pack)
    );

    const raw = await input.generateBatch({
      batchIndex: i,
      batchSize: input.batchSize,
      priorUtterances,
    });
    if (raw.length === 0) {
      stopReason = 'empty';
      break;
    }

    const batchId = `batch-${String(i + 1).padStart(3, '0')}`;
    const { scored, summary } = scoreBatchAgainstPrior({
      batchId,
      utterances: raw,
      priorUtterances,
      priorSignatures,
      pack: input.pack,
      config,
    });

    candidates.push(...scored);
    batchSummaries.push(summary);
    batchesRun += 1;

    const next = updatePlateauState({
      previousConsecutiveLow: consecutiveLow,
      previousConsecutiveNoLift: consecutiveNoLift,
      summary,
      batchSize: input.batchSize,
      config,
    });
    consecutiveLow = next.consecutiveLow;
    consecutiveNoLift = next.consecutiveNoLift;
    plateau = next.plateau;
    noLiftStop = next.noLiftStop;
    if (next.stopReason) {
      stopReason = next.stopReason;
      break;
    }
  }

  const report = buildNoveltyReport({
    priorPoolSize: input.prior?.length ?? 0,
    batches: batchSummaries,
    consecutiveLow,
    consecutiveNoLift,
    plateau: plateau || noLiftStop,
    config,
    stopReason,
  });

  return {
    plateau,
    noLiftStop,
    report,
    candidates,
    batchesRun,
    stopReason,
  };
}

/**
 * Hard augment: emit exactly `count` candidates; ignore novelty / plateau.
 * Still scores batches for the report (`stopReason: 'force'`).
 */
export async function runHardAugment(input: {
  pack: IntentParsePack;
  prior?: ScenarioCandidate[];
  count: number;
  chunkSize?: number;
  config?: Partial<PlateauConfig>;
  generateBatch: BatchGenerator;
}): Promise<SaturateLoopResult> {
  const config = { ...DEFAULT_PLATEAU_CONFIG, ...input.config };
  const chunkSize = Math.max(1, input.chunkSize ?? config.noLiftBatchSize);
  const target = Math.max(0, Math.floor(input.count));
  const candidates: ScenarioCandidate[] = [...(input.prior ?? [])];
  const batchSummaries = [];
  let batchesRun = 0;
  let produced = 0;
  let batchIndex = 0;

  while (produced < target) {
    const need = Math.min(chunkSize, target - produced);
    const priorUtterances = candidates.map((c) => c.utterance);
    const priorSignatures = candidates.map(
      (c) => c.parseSignature ?? parseSignature(c.utterance, input.pack)
    );

    const raw = await input.generateBatch({
      batchIndex,
      batchSize: need,
      priorUtterances,
    });
    if (raw.length === 0) break;

    const slice = raw.slice(0, need);
    const batchId = `force-${String(batchIndex + 1).padStart(3, '0')}`;
    const { scored, summary } = scoreBatchAgainstPrior({
      batchId,
      utterances: slice,
      priorUtterances,
      priorSignatures,
      pack: input.pack,
      config,
    });

    candidates.push(...scored);
    batchSummaries.push(summary);
    produced += scored.length;
    batchesRun += 1;
    batchIndex += 1;
  }

  const report = buildNoveltyReport({
    priorPoolSize: input.prior?.length ?? 0,
    batches: batchSummaries,
    consecutiveLow: 0,
    consecutiveNoLift: 0,
    plateau: false,
    config,
    stopReason: 'force',
    forcedCount: target,
  });

  return {
    plateau: false,
    noLiftStop: false,
    report,
    candidates,
    batchesRun,
    stopReason: 'force',
  };
}

export function llmBatchGenerator(input: {
  provider: LlmProvider;
  flowSteps: unknown;
  intents?: unknown;
  inventory?: unknown;
  structuredDraft?: unknown;
  productBlurb?: string;
  mode?: import('./generatePrompt.js').ScenarioGenerateMode;
  contextHint?: import('./generatePrompt.js').ContextGenerateHint;
}): BatchGenerator {
  return async (ctx) => {
    const result = await generateScenarioCandidates({
      provider: input.provider,
      batchSize: ctx.batchSize,
      flowSteps: input.flowSteps,
      intents: input.intents,
      inventory: input.inventory,
      structuredDraft: input.structuredDraft,
      priorUtterances: ctx.priorUtterances,
      productBlurb: input.productBlurb,
      mode: input.mode,
      contextHint: input.contextHint,
    });
    if (!result.ok) {
      throw new Error(result.errors.join('; '));
    }
    return result.candidates;
  };
}

/**
 * When the pack is muddy, rotate context-tree modes across batches so each
 * LLM batch only sees a reduced candidate set (auto clash-split).
 */
export function splitContextBatchGenerator(input: {
  pack: IntentParsePack;
  provider: LlmProvider;
  inventory?: unknown;
  structuredDraft?: unknown;
  productBlurb?: string;
  /** When false, behave like a normal flow generator. */
  enabled?: boolean;
}): { generateBatch: BatchGenerator; plan: import('./contextTree.js').ContextTreePlan } {
  const plan = buildContextTreePlan(input.pack);
  const enabled = input.enabled !== false && plan.muddy;

  if (!enabled) {
    return {
      plan,
      generateBatch: llmBatchGenerator({
        provider: input.provider,
        flowSteps: input.pack.steps,
        intents: { aliases: input.pack.aliases },
        inventory: input.inventory,
        structuredDraft: input.structuredDraft,
        productBlurb: input.productBlurb,
        mode: 'flow',
      }),
    };
  }

  return {
    plan,
    generateBatch: async (ctx) => {
      const mode = pickContextMode(plan, ctx.batchIndex);
      const slice = packSliceForMode(input.pack, mode);
      const result = await generateScenarioCandidates({
        provider: input.provider,
        batchSize: ctx.batchSize,
        flowSteps: slice.flowSteps,
        intents: slice.intents,
        inventory: input.inventory,
        structuredDraft: input.structuredDraft,
        priorUtterances: ctx.priorUtterances,
        productBlurb: input.productBlurb,
        mode: 'context',
        contextHint: {
          modeId: mode.id,
          focusStepIds: mode.focusStepIds,
          pathnameHints: mode.pathnameHints,
          triggerPhrases: mode.triggerPhrases,
          reason: mode.reason,
        },
      });
      if (!result.ok) {
        throw new Error(result.errors.join('; '));
      }
      return result.candidates;
    },
  };
}
