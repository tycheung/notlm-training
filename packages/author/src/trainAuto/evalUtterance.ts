import type { IntentParsePack, ParseUtteranceResult } from '@notlm/core';
import { parseUtterance } from '@notlm/core';
import type { EvalExpectation, EvalItem } from './types.js';

export function scoreUtterance(
  utterance: string,
  expect: EvalExpectation,
  pack: IntentParsePack
): Pick<EvalItem, 'passed' | 'actualStepId' | 'note'> {
  const parsed: ParseUtteranceResult = parseUtterance(utterance, pack);
  const actual = parsed.stepId;
  const want = expect.stepId;

  if (want === null) {
    // Negatives: must not land on a concrete step.
    const passed = actual === null;
    return {
      passed,
      actualStepId: actual,
      note: passed ? 'rejected-ok' : `false-positive:${actual}`,
    };
  }

  const passed = actual === want;
  return {
    passed,
    actualStepId: actual,
    note: passed ? 'hit' : `expected:${want} got:${actual ?? 'null'}`,
  };
}

export function makeEvalItem(
  utterance: string,
  expect: EvalExpectation,
  pack: IntentParsePack,
  id?: string
): EvalItem {
  const scored = scoreUtterance(utterance, expect, pack);
  return {
    id: id ?? `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    utterance,
    expect,
    at: new Date().toISOString(),
    ...scored,
  };
}
