import type { LlmProvider } from '@notlm-training/llm';
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

export function fixtureAuthorPackDraft(input: {
  inventory: unknown;
  structuredDraft: unknown;
}): AuthorPackDraftResult {
  const sd = input.structuredDraft as {
    steps?: Array<{ id: string; title?: string; kind?: string; requires?: string[] }>;
  };
  const steps = Array.isArray(sd?.steps) ? sd.steps : [];
  const flow = steps.map((s) => ({
    id: s.id,
    title: s.title ?? s.id.replace(/_/g, ' '),
    kind: s.kind ?? 'hard',
    requires: s.requires ?? [],
    keywords: [s.title ?? s.id, s.id.replace(/_/g, ' ')],
  }));
  if (!flow.length) {
    flow.push({
      id: 'start',
      title: 'Start',
      kind: 'hard',
      requires: [],
      keywords: ['start'],
    });
  }
  return {
    ok: true,
    draft: {
      manifest: { id: 'fixture-pack' },
      flow,
      controls: [],
      intents: {
        aliases: Object.fromEntries(
          flow.map((s) => [s.id, [`open ${s.title.toLowerCase()}`, s.title]])
        ),
      },
      binders: flow.map((s) => ({ stepId: s.id, path: 'data._fixture', op: 'truthy' })),
      corpus: [],
      raw: { fixture: true },
    },
  };
}

export async function authorPackDraft(input: {
  provider?: LlmProvider | null;
  inventory: unknown;
  structuredDraft: unknown;
  fixture?: boolean;
}): Promise<AuthorPackDraftResult> {
  if (input.fixture || !input.provider) {
    return fixtureAuthorPackDraft(input);
  }
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
