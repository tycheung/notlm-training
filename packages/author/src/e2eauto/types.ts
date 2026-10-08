/**
 * e2eauto — browser-free audit/NLU learning loop types.
 * Grades pack System One outcomes; learns only into host `.notlm/`.
 */

export type E2eGrade =
  | 'Correct'
  | 'Partly'
  | 'Wrong'
  | 'NoReply'
  | 'LayaRisk'
  | 'Hallucinated';

export type E2eExpect = {
  faqId?: string | null;
  stepId?: string | null;
  rawIntent?: string | null;
  /** When true, utterance must stay OOD / refuse (no product FAQ/goto steal). */
  ood?: boolean;
  /** When true, must NOT strong-match any FAQ (fallthrough allowed only if ood). */
  fallthrough?: boolean;
};

export type E2eCase = {
  id: string;
  utterance: string;
  expect: E2eExpect;
  source: string;
};

export type E2eOutcome = {
  strongFaqId: string | null;
  weakFaqId: string | null;
  stepId: string | null;
  rawIntent: string | null;
  ood: boolean;
  explainLast: boolean;
  contextAsk: boolean;
  /** Synthetic reply stub for grading (FAQ text / OOD refuse / step title). */
  replyStub: string;
};

export type E2eGraded = {
  case: E2eCase;
  outcome: E2eOutcome;
  grade: E2eGrade;
  reasons: string[];
  /** True when pack language should be updated for this case. */
  needsLearn: boolean;
};

export type E2eAutoConfig = {
  /** Scenario files relative to `.notlm/` home. */
  sources: string[];
  /** 0 = endless (until stopReason). */
  maxRounds: number;
  /** Max learn+checkpoint cycles (0 = unlimited). */
  maxLessons: number;
  /** Deterministic alias folds only (no LLM). */
  fixture: boolean;
  /** Persist pack writes after each lesson. */
  writePack: boolean;
  /** Copy pack snapshot under train-e2eauto/checkpoint/<n>/ before each write. */
  checkpointEvery: number;
  /** Optional ranker retrain cadence (0 = never). */
  retrainRankerEvery: number;
  /** When queue empties: reshuffle and continue (endless) vs stop. */
  reshuffle: boolean;
  /** Sleep ms between lessons (calm continuous runs). */
  pauseMs: number;
  /**
   * Stop when rolling/sweep F1 >= this (0 = disabled).
   * Uses FAQ/OOD/step label micro-F1 from @notlm/core metricsF1.
   */
  minF1: number;
  /** Minimum cases in a sweep before minF1 may stop the loop. */
  minF1Cases: number;
};

export type E2eAutoState = {
  round: number;
  lessons: number;
  cursor: number;
  seenIds: string[];
  lastGradeCounts: Record<E2eGrade, number>;
  updatedAt: string;
};

export type E2eAutoReport = {
  ok: boolean;
  rounds: number;
  lessons: number;
  stopReason:
    | 'max_rounds'
    | 'max_lessons'
    | 'queue_empty'
    | 'all_correct'
    | 'min_f1'
    | 'interrupted';
  gradeCounts: Record<E2eGrade, number>;
  f1?: {
    precision: number;
    recall: number;
    f1: number;
    support: number;
    confusion: { tp: number; fp: number; fn: number; tn: number };
  };
  history: Array<{
    round: number;
    caseId: string;
    grade: E2eGrade;
    learned: boolean;
    checkpoint?: string;
    f1?: number;
  }>;
};
