export type ScenarioCandidate = {
  id: string;
  utterance: string;
  batchId: string;
  /** Soft expect from LLM; never auto-merged into pack/. */
  expect?: {
    stepId?: string | null;
    rawIntent?: string | null;
    goBack?: boolean;
    isCorrection?: boolean;
  };
  parseSignature?: string;
  lexicalNovelty?: number;
  parseNovelty?: number;
  novelty?: number;
};

export type PlateauConfig = {
  epsilon: number;
  consecutiveBatches: number;
  noveltyFloor: number;
  lexicalWeight: number;
  /**
   * No-lift hard stop: consecutive batches with lift below noLiftEpsilon.
   * Normative: 5 consecutive passes of 100 — stop even if wording still looks diverse.
   */
  noLiftPasses: number;
  /** Recommended / default batch size for the no-lift rule (100). */
  noLiftBatchSize: number;
  noLiftEpsilon: number;
  liftFloor: number;
};

export const DEFAULT_PLATEAU_CONFIG: PlateauConfig = {
  epsilon: 0.15,
  consecutiveBatches: 2,
  noveltyFloor: 0.25,
  lexicalWeight: 0.55,
  noLiftPasses: 5,
  noLiftBatchSize: 100,
  noLiftEpsilon: 0.05,
  liftFloor: 0.35,
};

export type BatchNoveltySummary = {
  batchId: string;
  size: number;
  meanNovelty: number;
  meanLexicalNovelty: number;
  shareAboveFloor: number;
  lift: number;
  incrementalNovelty: number;
  belowEpsilon: boolean;
  noLift: boolean;
};

export type StopReason = 'plateau' | 'no-lift' | 'max-batches' | 'force' | 'empty';

export type NoveltyReport = {
  generatedAt: string;
  config: PlateauConfig;
  priorPoolSize: number;
  batches: BatchNoveltySummary[];
  plateau: boolean;
  consecutiveLow: number;
  consecutiveNoLift: number;
  stopReason?: StopReason;
  forcedCount?: number;
};

export type ParseSignatureBucket =
  | `step:${string}`
  | `meta:${string}`
  | 'null'
  | 'go_back'
  | 'correction'
  | 'clash';
