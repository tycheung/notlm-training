import type { LlmProvider } from '@uipilot/llm';
import { extractJsonText } from '../parseModelJson.js';
import {
  buildScenarioGeneratePrompt,
  type ContextGenerateHint,
  type ScenarioGenerateMode,
} from './generatePrompt.js';

export type GenerateCandidatesResult =
  | {
      ok: true;
      candidates: Array<{ id?: string; utterance: string }>;
      raw: unknown;
    }
  | { ok: false; errors: string[]; checklist: string[] };

export async function generateScenarioCandidates(input: {
  provider: LlmProvider;
  batchSize: number;
  flowSteps: unknown;
  intents?: unknown;
  inventory?: unknown;
  structuredDraft?: unknown;
  priorUtterances?: string[];
  productBlurb?: string;
  mode?: ScenarioGenerateMode;
  contextHint?: ContextGenerateHint;
}): Promise<GenerateCandidatesResult> {
  const prompt = buildScenarioGeneratePrompt({
    batchSize: input.batchSize,
    flowSteps: input.flowSteps,
    intents: input.intents,
    inventory: input.inventory,
    structuredDraft: input.structuredDraft,
    priorUtterances: input.priorUtterances ?? [],
    productBlurb: input.productBlurb,
    mode: input.mode,
    contextHint: input.contextHint,
  });

  const text = await input.provider.completeChat({
    messages: [
      {
        role: 'system',
        content:
          'Return JSON only with key "candidates": array of { id?, utterance }.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const extracted = extractJsonText(text);
  if (!extracted) {
    return {
      ok: false,
      errors: ['Could not extract JSON from model output'],
      checklist: ['Re-prompt for JSON only with candidates[]'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'parse failed';
    return {
      ok: false,
      errors: [`Invalid JSON: ${msg}`],
      checklist: [`Repair model JSON: ${msg}`],
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      ok: false,
      errors: ['Model JSON must be an object'],
      checklist: ['Return { "candidates": [...] }'],
    };
  }

  const raw = parsed as Record<string, unknown>;
  const list = Array.isArray(raw.candidates)
    ? raw.candidates
    : Array.isArray(raw.utterances)
      ? raw.utterances
      : null;

  if (!list) {
    return {
      ok: false,
      errors: ['Missing candidates array'],
      checklist: ['Include candidates: [{ utterance }]'],
    };
  }

  const candidates: Array<{ id?: string; utterance: string }> = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      candidates.push({ utterance: item.trim() });
      continue;
    }
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      const utterance =
        (typeof row.utterance === 'string' && row.utterance) ||
        (typeof row.text === 'string' && row.text) ||
        (typeof row.prompt === 'string' && row.prompt) ||
        '';
      if (!utterance.trim()) continue;
      candidates.push({
        id: typeof row.id === 'string' ? row.id : undefined,
        utterance: utterance.trim(),
      });
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      errors: ['No usable candidate utterances'],
      checklist: ['Model returned empty candidates'],
    };
  }

  return { ok: true, candidates, raw };
}
