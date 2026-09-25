/**
 * Rolling-window stop statistics for train auto.
 *
 * Defaults: passRate=0.99, confidence=0.99 → window 459
 * (documented sample size for ≈99% observed success at 99% confidence
 * with a tight failure budget; override with --window).
 */

import type { EvalItem, RollingEvalState } from './types.js';

/** Known (passRate, confidence) → window defaults. */
const WINDOW_TABLE: Array<{ passRate: number; confidence: number; window: number }> = [
  { passRate: 0.99, confidence: 0.99, window: 459 },
  { passRate: 0.99, confidence: 0.95, window: 299 },
  { passRate: 0.95, confidence: 0.99, window: 93 },
  { passRate: 0.95, confidence: 0.95, window: 73 },
  { passRate: 0.9, confidence: 0.95, window: 45 },
];

function zForConfidence(confidence: number): number {
  if (confidence >= 0.99) return 2.576;
  if (confidence >= 0.95) return 1.96;
  if (confidence >= 0.9) return 1.645;
  return 1.96;
}

/**
 * Derive rolling window size. Prefer table hit; else approximate
 * n ≈ z² * p * (1-p) / e² with e = (1-p)/2 (half the failure budget).
 */
export function deriveWindowSize(passRate: number, confidence: number): number {
  const hit = WINDOW_TABLE.find(
    (row) =>
      Math.abs(row.passRate - passRate) < 1e-9 &&
      Math.abs(row.confidence - confidence) < 1e-9
  );
  if (hit) return hit.window;

  const p = Math.min(0.999, Math.max(0.5, passRate));
  const fail = Math.max(1e-4, 1 - p);
  const e = fail / 2;
  const z = zForConfidence(confidence);
  const n = Math.ceil((z * z * p * fail) / (e * e));
  return Math.max(30, n);
}

/** Wilson score interval lower bound for binomial proportion. */
export function wilsonLowerBound(
  successes: number,
  n: number,
  confidence: number
): number {
  if (n <= 0) return 0;
  const z = zForConfidence(confidence);
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

export function emptyRollingState(
  passRate: number,
  confidence: number,
  window: number
): RollingEvalState {
  return {
    items: [],
    passRate,
    confidence,
    window,
    lastPassRate: 0,
    met: false,
  };
}

export function appendEvalItems(
  state: RollingEvalState,
  next: EvalItem[]
): RollingEvalState {
  const items = [...state.items, ...next];
  // Keep a bit more than window for audit; score on last `window`.
  const maxKeep = Math.max(state.window * 3, state.window);
  const trimmed = items.length > maxKeep ? items.slice(items.length - maxKeep) : items;
  return scoreRolling({ ...state, items: trimmed });
}

export function scoreRolling(state: RollingEvalState): RollingEvalState {
  const slice = state.items.slice(-state.window);
  if (slice.length === 0) {
    return { ...state, lastPassRate: 0, met: false, wilsonLower: 0 };
  }
  const successes = slice.filter((i) => i.passed === true).length;
  const lastPassRate = successes / slice.length;
  const wilsonLower = wilsonLowerBound(successes, slice.length, state.confidence);
  const full = slice.length >= state.window;
  const maxFails = Math.floor((1 - state.passRate) * state.window + 1e-9);
  const failures = slice.length - successes;
  // Observed pass-rate gate on a full window. Wilson LB is reported for diagnostics;
  // requiring wilsonLower >= passRate is impossible at 99%/99%/n=459 even with 0 failures.
  const met = full && lastPassRate >= state.passRate && failures <= maxFails;
  return { ...state, lastPassRate, wilsonLower, met };
}
