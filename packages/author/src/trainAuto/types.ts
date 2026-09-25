/** Shared types for autonomous `train auto` loop. */

export type TrainAutoAction =
  | 'generate'
  | 'label'
  | 'tune'
  | 'dag'
  | 'eval'
  | 'ranker'
  | 'noop';

export type TrainAutoPlan = {
  action: TrainAutoAction;
  rationale: string;
  params?: {
    batchSize?: number;
    includeNegatives?: boolean;
    maxIters?: number;
  };
};

export type EvalExpectation = {
  /** Expected step id; null means must reject / miss (no step). */
  stepId: string | null;
};

export type EvalItem = {
  id: string;
  utterance: string;
  expect: EvalExpectation;
  at: string;
  /** True when parse matched expectation. */
  passed?: boolean;
  actualStepId?: string | null;
  note?: string;
};

export type RollingEvalState = {
  items: EvalItem[];
  passRate: number;
  confidence: number;
  window: number;
  lastPassRate: number;
  met: boolean;
  wilsonLower?: number;
};

export type TrainAutoControlState = 'running' | 'paused' | 'stop';

export type TrainAutoControl = {
  state: TrainAutoControlState;
  updatedAt: string;
  note?: string;
};

export type TrainAutoConfig = {
  passRate: number;
  confidence: number;
  window: number;
  maxCpu: number;
  maxRam: number;
  workers: number;
  fixture: boolean;
  /** Composer nebula generator (drunk/FAQ/non-feature) — no LLM required. */
  composer: boolean;
  /** Keep growing until alias soft-cap; do not stop early on rolling.met. */
  untilSoftCap: boolean;
  resume: boolean;
  /** Hard cap on planner iterations (safety). */
  maxIterations: number;
  /** Cosine similarity above this → reject as near-duplicate. */
  diversityMaxSimilarity: number;
  /** Lexical novelty floor (0..1); below → reject. */
  diversityMinLexicalNovelty: number;
};

export type TrainAutoReport = {
  stoppedReason:
    | 'met'
    | 'stop'
    | 'max-iterations'
    | 'error'
    | 'soft-cap';
  iterations: number;
  rolling: RollingEvalState;
  config: TrainAutoConfig;
  finishedAt: string;
};

export const TRAIN_AUTO_ACTIONS: readonly TrainAutoAction[] = [
  'generate',
  'label',
  'tune',
  'dag',
  'eval',
  'ranker',
  'noop',
] as const;
