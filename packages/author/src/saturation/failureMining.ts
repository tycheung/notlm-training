import type { IntentCheckResult } from '@notlm/core';

export type FailureMineResult = {
  checklist: Array<Record<string, unknown>>;
  /** Suggested draft patch stubs (human/LLM refine via intents tune). */
  draftHints: {
    intentsNote: string;
    flowNote: string;
    failingUtterances: Array<{
      id?: string;
      utterance: string;
      errors: string[];
      actual: IntentCheckResult['actual'];
      expected: IntentCheckResult['expected'];
    }>;
  };
};

/** No pack merge — draft hints only. */
export function mineIntentFailures(
  failures: IntentCheckResult[],
  opts?: { draftIdPrefix?: string }
): FailureMineResult {
  const prefix = opts?.draftIdPrefix ?? 'sat-fail';
  const checklist: Array<Record<string, unknown>> = [];
  const failingUtterances = failures.map((f, i) => {
    const id = f.id ?? `${prefix}-${i + 1}`;
    checklist.push({
      id: `checklist-${id}`,
      kind: 'saturation-failure',
      message: `Intent border fail: "${f.utterance}" — ${f.errors.join('; ')}`,
      utterance: f.utterance,
      errors: f.errors,
      checked: false,
    });
    return {
      id: f.id,
      utterance: f.utterance,
      errors: f.errors,
      actual: f.actual,
      expected: f.expected,
    };
  });

  if (failures.length > 0) {
    checklist.push({
      id: `${prefix}-review-intents`,
      kind: 'intents-review',
      message:
        'Review aliases/keywords for saturation failures; run intents tune then pack accept',
      checked: false,
    });
    checklist.push({
      id: `${prefix}-review-flow`,
      kind: 'flow-review',
      message:
        'If failures imply missing steps or bad requires[], update flow.json DAG in a draft',
      checked: false,
    });
  }

  return {
    checklist,
    draftHints: {
      intentsNote:
        'Add aliases or corpus cases for failing utterances; prefer intents tune over hand-guessing.',
      flowNote:
        'Only change requires[]/keywords when failures show structural DAG gaps, not mere typos.',
      failingUtterances,
    },
  };
}
