import type { LlmProvider } from '@uipilot/llm';
import { extractJsonText, parseModelJson } from './parseModelJson.js';

export type DraftTalkResult = {
  ok: boolean;
  replies?: Record<string, string[]>;
  faq?: Array<{ id: string; aliases: string[]; text: string; stepId?: string }>;
  slotAsks?: Record<string, Array<{ key: string; ask: string; required?: boolean }>>;
  errors: string[];
  rawText?: string;
};

const FIXTURE_DRAFT: DraftTalkResult = {
  ok: true,
  replies: {
    launch: ['Taking you to “{{title}}”.', 'Opening “{{title}}”.'],
    confirm: ['I’ll open “{{title}}” — sound good?'],
    proactive: ['“{{done}}” is done. Next: “{{title}}”. Want me to go there?'],
    ask_slot: ['{{prompt}}'],
    cancel: ['Okay, cancelled.'],
    affirm_skip: ['Alright — say when you’re ready.'],
  },
  faq: [
    {
      id: 'draft_where',
      aliases: ['where am i', 'what screen is this'],
      text: 'Ask what’s next to see the best step from here.',
    },
  ],
  slotAsks: {},
  errors: [],
};

/**
 * Build-time draft of conversational reply banks / FAQ / slot prompts.
 * Fixture mode needs no LLM (CI-safe).
 */
export async function draftConversationalCopy(opts: {
  provider?: LlmProvider | null;
  fixture?: boolean;
  stepTitles?: Array<{ id: string; title: string }>;
  productBlurb?: string;
}): Promise<DraftTalkResult> {
  if (opts.fixture || !opts.provider) {
    const slotAsks: DraftTalkResult['slotAsks'] = {};
    for (const step of opts.stepTitles ?? []) {
      slotAsks[step.id] = [
        {
          key: 'name',
          ask: `What should we use for “${step.title}”?`,
          required: true,
        },
      ];
    }
    return { ...FIXTURE_DRAFT, slotAsks, errors: [] };
  }

  const titles = (opts.stepTitles ?? [])
    .map((s) => `- ${s.id}: ${s.title}`)
    .join('\n');
  const prompt = `You draft JSON for a deterministic UI coach (no runtime LLM).
Return ONLY JSON with keys:
  replies: object of string[] (keys: launch, confirm, proactive, ask_slot, cancel, affirm_skip; use {{title}} {{done}} {{prompt}})
  faq: array of { id, aliases[], text }
  slotAsks: object of stepId -> [{ key, ask, required? }]
Product blurb: ${opts.productBlurb ?? '(none)'}
Steps:
${titles || '(none)'}`;

  try {
    const raw = await opts.provider.completeChat({
      messages: [
        { role: 'system', content: 'Return only valid JSON for UiPilot pack drafts.' },
        { role: 'user', content: prompt },
      ],
    });
    const jsonText = extractJsonText(raw) ?? raw;
    const parsed = parseModelJson(jsonText);
    if (!parsed.ok) {
      return { ok: false, errors: parsed.errors, rawText: raw };
    }
    const data = parsed.data as Record<string, unknown>;
    return {
      ok: true,
      replies:
        data.replies && typeof data.replies === 'object'
          ? (data.replies as Record<string, string[]>)
          : undefined,
      faq: Array.isArray(data.faq) ? (data.faq as DraftTalkResult['faq']) : undefined,
      slotAsks:
        data.slotAsks && typeof data.slotAsks === 'object'
          ? (data.slotAsks as DraftTalkResult['slotAsks'])
          : undefined,
      errors: [],
      rawText: raw,
    };
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
