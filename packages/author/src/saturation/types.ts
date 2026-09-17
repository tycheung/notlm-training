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
  /** Deterministic parse signature after scoring (optional cache). */
  parseSignature?: string;
  lexicalNovelty?: number;
  parseNovelty?: number;
  novelty?: number;
};

export type PlateauConfig = {
  /** Batch incremental novelty below this → counts toward classic plateau. */
  epsilon: number;
  /** Consecutive low combined-novelty batches required to declare classic plateau. */
  consecutiveBatches: number;
  /** Per-utterance novelty floor for “new ground” share (combined). */
  noveltyFloor: number;
  /** Lexical vs parse-signature blend (0..1 lexical weight). */
  lexicalWeight: number;
  /**
   * No-lift hard stop: consecutive batches with lift below noLiftEpsilon.
   * Normative: 5 consecutive passes of 100 — stop even if wording still looks diverse.
   */
  noLiftPasses: number;
  /** Recommended / default batch size for the no-lift rule (100). */
  noLiftBatchSize: number;
  /** Lift (parse-signature share above floor) below this ⇒ “no lift”. */
  noLiftEpsilon: number;
  /** Parse-novelty floor for lift share. */
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
  /** Mean novelty of utterances in the batch vs prior pool. */
  meanNovelty: number;
  /** Mean lexical novelty (wording diversity — can stay high after lift dies). */
  meanLexicalNovelty: number;
  /** Share of utterances with novelty >= noveltyFloor. */
  shareAboveFloor: number;
  /** Parse-signature lift share (intent-border new ground). */
  lift: number;
  /** Incremental novelty used for classic plateau (shareAboveFloor by default). */
  incrementalNovelty: number;
  belowEpsilon: boolean;
  /** True when lift < noLiftEpsilon (no intent-border lift this batch). */
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
