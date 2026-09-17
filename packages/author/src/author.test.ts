import { describe, expect, it } from 'vitest';
import { authorPackDraft } from './packAuthor.js';
import { tuneIntents } from './intentsTune.js';
import { checkIntents } from '@uipilot/core';
import { parseModelJson } from './parseModelJson.js';
import { buildIntentTunePrompt, buildPackAuthorPrompt } from './prompts.js';
import type { LlmProvider } from '@uipilot/llm';

function mockProvider(text: string): LlmProvider {
  return {
    async completeChat() {
      return text;
    },
  };
}

const flow = [
  {
    id: 'create_list',
    title: 'Create list',
    keywords: ['create list', 'new list'],
    kind: 'hard' as const,
    requires: [] as string[],
  },
];

describe('prompts', () => {
  it('asks for JSON only', () => {
    const p = buildPackAuthorPrompt({ inventory: { controls: [] }, structuredDraft: { steps: [] } });
    expect(p).toMatch(/JSON object only/i);
    const t = buildIntentTunePrompt({
      currentIntents: { aliases: {} },
      scenarios: [],
    });
    expect(t).toMatch(/JSON object only/i);
  });
});

describe('parseModelJson', () => {
  it('strips fences and validates', () => {
    const result = parseModelJson(`Here you go:
\`\`\`json
{
  "manifest": { "id": "demo" },
  "flow": [{ "id": "a", "title": "A", "kind": "hard", "requires": [] }],
  "intents": { "aliases": { "a": ["do a"] } },
  "binders": [{ "stepId": "a", "path": "data.x", "op": "truthy" }]
}
\`\`\`
`);
    expect(result.ok).toBe(true);
  });

  it('returns checklist errors on invalid JSON', () => {
    const result = parseModelJson('not json at all');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.checklist.length).toBeGreaterThan(0);
    }
  });
});

describe('authorPackDraft', () => {
  it('returns draft pieces from mock provider', async () => {
    const provider = mockProvider(
      JSON.stringify({
        manifest: { id: 'demo' },
        flow: [{ id: 'a', title: 'A', kind: 'hard', requires: [] }],
        controls: [],
        intents: { aliases: { a: ['do a'] } },
        binders: [{ stepId: 'a', path: 'data.x', op: 'truthy' }],
        corpus: [],
      })
    );
    const result = await authorPackDraft({
      provider,
      inventory: {},
      structuredDraft: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.manifest).toMatchObject({ id: 'demo' });
    }
  });
});

describe('tuneIntents', () => {
  it('returns proposed intents and corpus', async () => {
    const provider = mockProvider(
      JSON.stringify({
        intents: { aliases: { create_list: ['make list'] }, meta: ['whats_next'] },
        corpus: [{ utterance: 'make list', expect: { stepId: 'create_list' } }],
      })
    );
    const result = await tuneIntents({
      provider,
      currentIntents: { aliases: {} },
      scenarios: [{ utterance: 'make list', expect: { stepId: 'create_list' } }],
      failingCases: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intents).toMatchObject({ aliases: { create_list: ['make list'] } });
    }
  });
});

describe('checkIntents', () => {
  it('passes matching scenarios and supports stepId null', () => {
    const { ok, results } = checkIntents({
      pack: {
        manifest: { id: 'demo-todo' },
        flow,
        intents: {
          aliases: { create_list: ['make a list'] },
          meta: ['whats_next'],
        },
        binders: [{ stepId: 'create_list', path: 'data.listCount', op: 'gte', value: 1 }],
      },
      scenarios: [
        { id: 'pos', utterance: 'make a list', expect: { stepId: 'create_list' } },
        { id: 'neg', utterance: 'completely unrelated xyzzy', expect: { stepId: null } },
      ],
    });
    expect(ok).toBe(true);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails when expect mismatches', () => {
    const { ok, results } = checkIntents({
      pack: {
        manifest: { id: 'demo-todo' },
        flow,
        intents: { aliases: { create_list: ['make a list'] } },
      },
      scenarios: [{ utterance: 'make a list', expect: { stepId: null } }],
    });
    expect(ok).toBe(false);
    expect(results[0]?.errors[0]).toMatch(/stepId/);
  });
});
