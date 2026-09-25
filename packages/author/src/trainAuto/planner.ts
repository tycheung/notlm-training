import type { LlmProvider } from '@uipilot/llm';
import { extractJsonText } from '../parseModelJson.js';
import {
  TRAIN_AUTO_ACTIONS,
  type TrainAutoAction,
  type TrainAutoPlan,
  type RollingEvalState,
} from './types.js';

export function buildPlannerPrompt(input: {
  stepIds: string[];
  rolling: RollingEvalState;
  iteration: number;
  lastActions: string[];
}): string {
  return [
    'You are an offline NLU training planner for a UI coach pack.',
    'Pick ONE next action from the toolbox. Respond with JSON only:',
    '{ "action": "generate|label|tune|dag|eval|ranker|noop", "rationale": "...", "params": { "batchSize": 8, "includeNegatives": true } }',
    'Rules:',
    '- Prefer generate when rolling window is not full or pass rate is low.',
    '- includeNegatives: invent off-topic questions that must NOT map to any step.',
    '- Generate ORTHOGONAL phrasing (not paraphrases of prior hits).',
    '- dag only when inventory-backed structural fixes are needed; otherwise avoid.',
    '- tune after labeled failures accumulate.',
    '- eval to measure the rolling window.',
    '- ranker sparingly after intents are stable.',
    '',
    `iteration: ${input.iteration}`,
    `stepIds: ${JSON.stringify(input.stepIds)}`,
    `rolling: window=${input.rolling.window} filled=${Math.min(input.rolling.items.length, input.rolling.window)} lastPassRate=${input.rolling.lastPassRate.toFixed(4)} met=${input.rolling.met} target=${input.rolling.passRate}`,
    `recentActions: ${JSON.stringify(input.lastActions.slice(-8))}`,
  ].join('\n');
}

export function parsePlannerResponse(text: string): TrainAutoPlan | null {
  const extracted = extractJsonText(text);
  if (!extracted) return null;
  let data: unknown;
  try {
    data = JSON.parse(extracted);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const action = String(o.action ?? '') as TrainAutoAction;
  if (!TRAIN_AUTO_ACTIONS.includes(action)) return null;
  const rationale = typeof o.rationale === 'string' ? o.rationale : '';
  const paramsRaw = o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : {};
  const batchSize =
    typeof paramsRaw.batchSize === 'number' && paramsRaw.batchSize > 0
      ? Math.floor(paramsRaw.batchSize)
      : undefined;
  const includeNegatives =
    typeof paramsRaw.includeNegatives === 'boolean' ? paramsRaw.includeNegatives : undefined;
  return {
    action,
    rationale,
    params: { batchSize, includeNegatives },
  };
}

export async function planNextAction(input: {
  provider: LlmProvider | null;
  fixture: boolean;
  iteration: number;
  stepIds: string[];
  rolling: RollingEvalState;
  lastActions: string[];
}): Promise<TrainAutoPlan> {
  if (input.fixture || !input.provider) {
    return fixturePlan(input.iteration, input.rolling);
  }
  const prompt = buildPlannerPrompt({
    stepIds: input.stepIds,
    rolling: input.rolling,
    iteration: input.iteration,
    lastActions: input.lastActions,
  });
  const text = await input.provider.completeChat({
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = parsePlannerResponse(text);
  if (parsed) return parsed;
  return fixturePlan(input.iteration, input.rolling);
}

/** Deterministic planner for CI / fallback. */
export function fixturePlan(iteration: number, rolling: RollingEvalState): TrainAutoPlan {
  if (rolling.met) return { action: 'noop', rationale: 'met' };
  const phase = iteration % 4;
  if (phase === 0) {
    return {
      action: 'generate',
      rationale: 'fixture: diversify pool',
      params: { batchSize: 6, includeNegatives: true },
    };
  }
  if (phase === 1) {
    return { action: 'label', rationale: 'fixture: soft-label recent' };
  }
  if (phase === 2) {
    return { action: 'tune', rationale: 'fixture: fold aliases from labels' };
  }
  return { action: 'eval', rationale: 'fixture: score rolling window' };
}
