import {
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_MID_MIN,
  probabilityToConfidence,
} from '@notlm/core';
import {
  evaluateRankerSoftScore,
  inferRankerJson,
  type RankerBandMetrics,
  type RankerEvalCase,
  type RankerModelJson,
} from '@notlm/ranker';

export type CalibrationReport = {
  /** Soft-score hit rate (existing gate). */
  hitRate: number;
  hits: number;
  total: number;
  bands: RankerBandMetrics;
  /**
   * Simple expected calibration error over 10 equal bins of predicted p.
   * Lower is better; undefined when no labeled cases.
   */
  ece: number | null;
  thresholds: { highMin: number; midMin: number };
};

/**
 * Per-band accuracy + ECE for a trained ranker on labeled scenarios/corpus.
 * Uses top-intent probability as the confidence score.
 */
export function reportRankerCalibration(
  model: RankerModelJson,
  cases: RankerEvalCase[],
  opts?: { minProbability?: number; bins?: number }
): CalibrationReport {
  const soft = evaluateRankerSoftScore(model, cases, {
    minProbability: opts?.minProbability ?? 0.35,
    minHitRate: 0,
  });
  const bins = Math.max(2, opts?.bins ?? 10);
  const labeled = cases.filter((c) => {
    const e = c.expect;
    return e && (e.goBack || e.rawIntent || typeof e.stepId === 'string');
  });

  const bucketHits = new Array(bins).fill(0) as number[];
  const bucketCount = new Array(bins).fill(0) as number[];
  const bucketSumP = new Array(bins).fill(0) as number[];

  for (const c of labeled) {
    const inferred = inferRankerJson(model, c.utterance);
    const p = inferred.intent.probability;
    const want = expectedLabel(c);
    if (!want) continue;
    const correct = inferred.intent.label === want ? 1 : 0;
    const bi = Math.min(bins - 1, Math.floor(p * bins));
    bucketCount[bi]! += 1;
    bucketHits[bi]! += correct;
    bucketSumP[bi]! += p;
    // Touch bands via probabilityToConfidence for stability under strips.
    void probabilityToConfidence(p);
  }

  let eceAcc = 0;
  let eceN = 0;
  for (let i = 0; i < bins; i += 1) {
    const n = bucketCount[i]!;
    if (n === 0) continue;
    const acc = bucketHits[i]! / n;
    const avgP = bucketSumP[i]! / n;
    eceAcc += n * Math.abs(acc - avgP);
    eceN += n;
  }

  return {
    hitRate: soft.hitRate,
    hits: soft.hits,
    total: soft.total,
    bands: soft.bands,
    ece: eceN === 0 ? null : eceAcc / eceN,
    thresholds: { highMin: CONFIDENCE_HIGH_MIN, midMin: CONFIDENCE_MID_MIN },
  };
}

function expectedLabel(c: RankerEvalCase): string | null {
  const e = c.expect;
  if (e.goBack) return 'go_back';
  if (e.rawIntent === 'whats_next') return 'whats_next';
  if (e.rawIntent) return e.rawIntent;
  if (typeof e.stepId === 'string' && e.stepId) return `goto:${e.stepId}`;
  return null;
}

/** One-line summary for CLI logs. */
export function formatCalibrationSummary(report: CalibrationReport): string {
  const ece =
    report.ece == null ? 'n/a' : report.ece.toFixed(3);
  const { high, mid, low } = report.bands;
  return (
    `calibration hit=${report.hitRate.toFixed(3)} ` +
    `high=${high.hits}/${high.total} mid=${mid.hits}/${mid.total} ` +
    `low=${low.hits}/${low.total} ece=${ece}`
  );
}
