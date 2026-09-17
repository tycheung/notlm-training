import type { LlmProvider } from '@uipilot/llm';
import { buildPackAuthorPrompt } from './prompts.js';
import { parseModelJson } from './parseModelJson.js';

export type PackDraftPieces = {
  manifest?: unknown;
  flow?: unknown;
  controls?: unknown;
  intents?: unknown;
  binders?: unknown;
  corpus?: unknown;
  raw?: Record<string, unknown>;
};

export type AuthorPackDraftResult =
  | { ok: true; draft: PackDraftPieces }
  | { ok: false; errors: string[]; checklist: string[] };

export async function authorPackDraft(input: {
  provider: LlmProvider;
  inventory: unknown;
  structuredDraft: unknown;
}): Promise<AuthorPackDraftResult> {
  const prompt = buildPackAuthorPrompt({
    inventory: input.inventory,
    structuredDraft: input.structuredDraft,
  });

  const text = await input.provider.completeChat({
    messages: [
      {
        role: 'system',
        content: 'Return JSON only. No markdown commentary.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const parsed = parseModelJson(text);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors, checklist: parsed.checklist };
  }

  const draft: PackDraftPieces = {
    raw: parsed.data,
    manifest: parsed.data.manifest,
    flow: parsed.data.flow,
    controls: parsed.data.controls,
    intents: parsed.data.intents,
    binders: parsed.data.binders,
    corpus: parsed.data.corpus,
  };

  return { ok: true, draft };
}
