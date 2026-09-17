import type { IntentParsePack } from '@uipilot/core';
import { lexicalNovelty } from './lexicalNovelty.js';
import { parseSignature, parseSignatureNovelty } from './parseSignatureNovelty.js';
import {
  DEFAULT_PLATEAU_CONFIG,
  type BatchNoveltySummary,
  type NoveltyReport,
  type PlateauConfig,
  type ScenarioCandidate,
  type StopReason,
} from './types.js';

export type ScoredCandidate = ScenarioCandidate & {
  parseSignature: string;
  lexicalNovelty: number;
  parseNovelty: number;
  novelty: number;
};

export function combineNovelty(
  lexical: number,
  parseSig: number,
  lexicalWeight: number
): number {
  const w = Math.max(0, Math.min(1, lexicalWeight));
  return w * lexical + (1 - w) * parseSig;
}

export function scoreBatchAgainstPrior(input: {
  batchId: string;
  utterances: readonly { id?: string; utterance: string }[];
  priorUtterances: readonly string[];
  priorSignatures: readonly string[];
  pack: IntentParsePack;
  config?: Partial<PlateauConfig>;
}): { scored: ScoredCandidate[]; summary: BatchNoveltySummary } {
  const config = { ...DEFAULT_PLATEAU_CONFIG, ...input.config };
  const scored: ScoredCandidate[] = [];

  const lexPrior = [...input.priorUtterances];
  const sigPrior = [...input.priorSignatures];

  for (let i = 0; i < input.utterances.length; i++) {
    const row = input.utterances[i]!;
    const sig = parseSignature(row.utterance, input.pack);
    const lex = lexicalNovelty(row.utterance, lexPrior);
    const pNov = parseSignatureNovelty(sig, sigPrior);
    const novelty = combineNovelty(lex, pNov, config.lexicalWeight);
    const id = row.id ?? `${input.batchId}-${i + 1}`;
    scored.push({
      id,
      utterance: row.utterance,
      batchId: input.batchId,
      parseSignature: sig,
      lexicalNovelty: lex,
      parseNovelty: pNov,
      novelty,
    });
    lexPrior.push(row.utterance);
    sigPrior.push(sig);
  }

  const meanNovelty =
    scored.length === 0
      ? 0
      : scored.reduce((s, c) => s + c.novelty, 0) / scored.length;
  const meanLexicalNovelty =
    scored.length === 0
      ? 0
      : scored.reduce((s, c) => s + c.lexicalNovelty, 0) / scored.length;
  const above = scored.filter((c) => c.novelty >= config.noveltyFloor).length;
  const shareAboveFloor = scored.length === 0 ? 0 : above / scored.length;
  const liftCount = scored.filter((c) => c.parseNovelty >= config.liftFloor).length;
  const lift = scored.length === 0 ? 0 : liftCount / scored.length;
  const incrementalNovelty = shareAboveFloor;
  const summary: BatchNoveltySummary = {
    batchId: input.batchId,
    size: scored.length,
    meanNovelty,
    meanLexicalNovelty,
    shareAboveFloor,
    lift,
    incrementalNovelty,
    belowEpsilon: incrementalNovelty < config.epsilon,
    noLift: lift < config.noLiftEpsilon,
  };
  return { scored, summary };
}

export function estimateIncrementalNovelty(
  summary: BatchNoveltySummary
): number {
  return summary.incrementalNovelty;
}

export type PlateauState = {
  consecutiveLow: number;
  consecutiveNoLift: number;
  plateau: boolean;
  noLiftStop: boolean;
  stopReason?: StopReason;
};

export function updatePlateauState(input: {
  previousConsecutiveLow: number;
  previousConsecutiveNoLift?: number;
  summary: BatchNoveltySummary;
  batchSize: number;
  config?: Partial<PlateauConfig>;
}): PlateauState {
  const config = { ...DEFAULT_PLATEAU_CONFIG, ...input.config };
  const consecutiveLow = input.summary.belowEpsilon
    ? input.previousConsecutiveLow + 1
    : 0;

  // Count no-lift passes when batch is the normative size (100) or larger chunk.
  const countsForNoLift = input.batchSize >= config.noLiftBatchSize;
  const consecutiveNoLift =
    countsForNoLift && input.summary.noLift
      ? (input.previousConsecutiveNoLift ?? 0) + 1
      : countsForNoLift
        ? 0
        : (input.previousConsecutiveNoLift ?? 0);

  const plateau = consecutiveLow >= config.consecutiveBatches;
  const noLiftStop = consecutiveNoLift >= config.noLiftPasses;

  let stopReason: StopReason | undefined;
  if (noLiftStop) stopReason = 'no-lift';
  else if (plateau) stopReason = 'plateau';

  return {
    consecutiveLow,
    consecutiveNoLift,
    plateau,
    noLiftStop,
    stopReason,
  };
}

export function buildNoveltyReport(input: {
  priorPoolSize: number;
  batches: BatchNoveltySummary[];
  consecutiveLow: number;
  consecutiveNoLift?: number;
  plateau: boolean;
  config?: Partial<PlateauConfig>;
  stopReason?: StopReason;
  forcedCount?: number;
}): NoveltyReport {
  const config = { ...DEFAULT_PLATEAU_CONFIG, ...input.config };
  return {
    generatedAt: new Date().toISOString(),
    config,
    priorPoolSize: input.priorPoolSize,
    batches: input.batches,
    plateau: input.plateau,
    consecutiveLow: input.consecutiveLow,
    consecutiveNoLift: input.consecutiveNoLift ?? 0,
    stopReason: input.stopReason,
    forcedCount: input.forcedCount,
  };
}

export function detectPlateau(
  batchSummaries: readonly BatchNoveltySummary[],
  config?: Partial<PlateauConfig>,
  batchSize?: number
): {
  plateau: boolean;
  noLiftStop: boolean;
  consecutiveLow: number;
  consecutiveNoLift: number;
  stopReason?: StopReason;
} {
  const cfg = { ...DEFAULT_PLATEAU_CONFIG, ...config };
  const size = batchSize ?? cfg.noLiftBatchSize;
  let consecutiveLow = 0;
  let consecutiveNoLift = 0;
  let plateau = false;
  let noLiftStop = false;
  let stopReason: StopReason | undefined;
  for (const s of batchSummaries) {
    const next = updatePlateauState({
      previousConsecutiveLow: consecutiveLow,
      previousConsecutiveNoLift: consecutiveNoLift,
      summary: s,
      batchSize: size,
      config: cfg,
    });
    consecutiveLow = next.consecutiveLow;
    consecutiveNoLift = next.consecutiveNoLift;
    plateau = next.plateau;
    noLiftStop = next.noLiftStop;
    stopReason = next.stopReason;
    if (plateau || noLiftStop) break;
  }
  return { plateau, noLiftStop, consecutiveLow, consecutiveNoLift, stopReason };
}
