import type { LlmProvider } from '@uipilot/llm';
import { extractJsonText } from '../parseModelJson.js';
import type { LabelContext, LabelProvider } from '../labeler/layaLabeler.js';
import { buildSoftLabelPrompt } from './generatePrompt.js';

export type SoftLabeledScenario = {
  id: string;
  utterance: string;
  expect: {
    stepId?: string | null;
    rawIntent?: string | null;
    goBack?: boolean;
    isCorrection?: boolean;
    /** Product Q&A — draft into pack/faq.json after review. */
    faqId?: string | null;
    answer?: string;
    guideId?: string;
  };
};

export type SoftLabelResult =
  | { ok: true; scenarios: SoftLabeledScenario[]; raw: unknown }
  | { ok: false; errors: string[]; checklist: string[] };

export type { LabelContext, LabelProvider };

/** Prefer LabelProvider (Laya / mock); else LLM soft-label. */
export async function labelCandidates(input: {
  labeler?: LabelProvider;
  provider?: LlmProvider;
  candidates: Array<{ id?: string; utterance: string }>;
  flowSteps: unknown;
  intents?: unknown;
  faq?: unknown;
  productBlurb?: string;
  guideByStep?: Record<string, string>;
}): Promise<SoftLabelResult> {
  if (input.labeler) {
    return input.labeler.labelCandidates({
      candidates: input.candidates,
      flowSteps: input.flowSteps,
      intents: input.intents,
      faq: input.faq,
      productBlurb: input.productBlurb,
      guideByStep: input.guideByStep,
    });
  }
  if (!input.provider) {
    return {
      ok: false,
      errors: ['No labeler or LLM provider'],
      checklist: ['Set UIPILOT_LABELER=laya|mock or UIPILOT_LLM_*'],
    };
  }
  return softLabelCandidates({
    provider: input.provider,
    candidates: input.candidates,
    flowSteps: input.flowSteps,
    intents: input.intents,
    faq: input.faq,
    productBlurb: input.productBlurb,
  });
}

export async function softLabelCandidates(input: {
  provider: LlmProvider;
  candidates: Array<{ id?: string; utterance: string }>;
  flowSteps: unknown;
  intents?: unknown;
  faq?: unknown;
  productBlurb?: string;
}): Promise<SoftLabelResult> {
  const prompt = buildSoftLabelPrompt({
    candidates: input.candidates,
    flowSteps: input.flowSteps,
    intents: input.intents,
    faq: input.faq,
    productBlurb: input.productBlurb,
  });

  const text = await input.provider.completeChat({
    messages: [
      {
        role: 'system',
        content: 'Return JSON only with key "scenarios".',
      },
      { role: 'user', content: prompt },
    ],
  });

  const extracted = extractJsonText(text);
  if (!extracted) {
    return {
      ok: false,
      errors: ['Could not extract JSON from soft-label output'],
      checklist: ['Re-prompt for scenarios JSON'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'parse failed';
    return { ok: false, errors: [`Invalid JSON: ${msg}`], checklist: [msg] };
  }

  const raw = parsed as Record<string, unknown>;
  const list = Array.isArray(raw.scenarios) ? raw.scenarios : null;
  if (!list) {
    return {
      ok: false,
      errors: ['Missing scenarios array'],
      checklist: ['Return { "scenarios": [...] }'],
    };
  }

  const scenarios: SoftLabeledScenario[] = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const row = item as Record<string, unknown>;
    const utterance =
      (typeof row.utterance === 'string' && row.utterance) ||
      input.candidates[i]?.utterance ||
      '';
    if (!utterance.trim()) return;
    const expect =
      row.expect && typeof row.expect === 'object'
        ? (row.expect as SoftLabeledScenario['expect'])
        : { stepId: null };
    scenarios.push({
      id:
        (typeof row.id === 'string' && row.id) ||
        input.candidates[i]?.id ||
        `soft-${i + 1}`,
      utterance: utterance.trim(),
      expect,
    });
  });

  if (scenarios.length === 0) {
    return {
      ok: false,
      errors: ['No soft-labeled scenarios'],
      checklist: ['Model returned empty scenarios'],
    };
  }

  return { ok: true, scenarios, raw };
}

/** Collapse soft-label FAQ answers into draft faq.json entries. */
export function faqDraftFromSoftLabels(
  scenarios: SoftLabeledScenario[]
): Array<{ id: string; aliases: string[]; text: string }> {
  const byId = new Map<string, { id: string; aliases: Set<string>; text: string }>();
  for (const s of scenarios) {
    const faqId = s.expect.faqId?.trim();
    const answer = s.expect.answer?.trim();
    if (!faqId || !answer) continue;
    if (s.expect.rawIntent && s.expect.rawIntent !== 'faq') continue;
    let row = byId.get(faqId);
    if (!row) {
      row = { id: faqId, aliases: new Set<string>(), text: answer };
      byId.set(faqId, row);
    }
    row.aliases.add(s.utterance.toLowerCase());
    if (answer.length > row.text.length) row.text = answer;
  }
  return [...byId.values()].map((r) => ({
    id: r.id,
    aliases: [...r.aliases],
    text: r.text,
  }));
}
