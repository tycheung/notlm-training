import { validatePackFolder } from '@notlm/schema';
import type { LlmProvider } from '@notlm-training/llm';
import { buildIntentTunePrompt } from './prompts.js';
import { extractJsonText } from './parseModelJson.js';

export type TuneIntentsResult =
  | {
      ok: true;
      intents: unknown;
      corpus: unknown;
      raw: Record<string, unknown>;
    }
  | { ok: false; errors: string[]; checklist: string[]; raw?: Record<string, unknown> };

export function fixtureTuneIntents(input: {
  currentIntents: unknown;
  scenarios: unknown;
}): TuneIntentsResult {
  const intents = structuredClone(input.currentIntents ?? { aliases: {} }) as {
    aliases?: Record<string, string[]>;
  };
  if (!intents.aliases || typeof intents.aliases !== 'object') {
    intents.aliases = {};
  }
  const corpus: Array<{ utterance: string; expect: { stepId: string | null } }> = [];
  const scenarios = Array.isArray(input.scenarios) ? input.scenarios : [];
  for (const raw of scenarios) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { utterance?: string; expect?: { stepId?: string | null } };
    const utterance = typeof row.utterance === 'string' ? row.utterance.trim() : '';
    const stepId = row.expect?.stepId;
    if (!utterance) continue;
    if (typeof stepId === 'string' && stepId) {
      (intents.aliases[stepId] ??= []).push(utterance);
      corpus.push({ utterance, expect: { stepId } });
    } else if (stepId === null) {
      corpus.push({ utterance, expect: { stepId: null } });
    }
  }
  for (const [k, list] of Object.entries(intents.aliases)) {
    intents.aliases[k] = [...new Set(list.map((t) => t.trim()).filter(Boolean))];
  }
  return { ok: true, intents, corpus, raw: { fixture: true } };
}

export async function tuneIntents(input: {
  provider?: LlmProvider | null;
  currentIntents: unknown;
  scenarios: unknown;
  failingCases?: unknown;
  inventory?: unknown;
  flowSteps?: unknown;
  fixture?: boolean;
}): Promise<TuneIntentsResult> {
  if (input.fixture || !input.provider) {
    return fixtureTuneIntents(input);
  }
  const prompt = buildIntentTunePrompt({
    currentIntents: input.currentIntents,
    scenarios: input.scenarios,
    failingCases: input.failingCases,
    inventory: input.inventory,
    flowSteps: input.flowSteps,
  });

  const text = await input.provider.completeChat({
    messages: [
      {
        role: 'system',
        content: 'Return JSON only with keys intents and corpus.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const extracted = extractJsonText(text);
  if (!extracted) {
    return {
      ok: false,
      errors: ['Could not extract JSON from model output'],
      checklist: ['Re-prompt for JSON only with intents + corpus'],
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

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ['Expected JSON object with intents and corpus'],
      checklist: ['Model must return { intents, corpus }'],
    };
  }

  const raw = parsed as Record<string, unknown>;
  const intents = raw.intents ?? { aliases: {} };
  const corpus = normalizeCorpus(raw.corpus);

  const validation = validatePackFolder({
    intents,
    corpus,
  });
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      checklist: [
        'Fix schema validation errors before accepting tuned intents:',
        ...validation.errors.map((e) => `- ${e}`),
      ],
      raw,
    };
  }

  return {
    ok: true,
    intents,
    corpus,
    raw,
  };
}

/** Coerce common LLM corpus shapes into ScenarioCase[]. */
function normalizeCorpus(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, i) => {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { id: `tune-${i}`, utterance: '', expect: { stepId: null } };
    }
    const e = entry as Record<string, unknown>;
    const utterance =
      (typeof e.utterance === 'string' && e.utterance) ||
      (typeof e.text === 'string' && e.text) ||
      (typeof e.input === 'string' && e.input) ||
      (typeof e.prompt === 'string' && e.prompt) ||
      '';
    let expect = e.expect;
    if (expect == null || typeof expect !== 'object') {
      expect = {
        stepId: (e.stepId as string | null | undefined) ?? null,
      };
    }
    return {
      id: typeof e.id === 'string' ? e.id : `tune-${i}`,
      utterance,
      expect,
    };
  });
}
