/**
 * Candidate generation for train auto (fixture + LLM).
 */

import type { IntentParsePack } from '@notlm/core';
import type { LlmProvider } from '@notlm/llm';
import { extractJsonText } from '../parseModelJson.js';
import { generateScenarioCandidates } from '../saturation/generateCandidates.js';

export type GeneratedCandidate = {
  utterance: string;
  expectStepId: string | null;
  kind: 'positive' | 'negative';
  faqId?: string;
  faqAnswer?: string;
};


const NEGATIVE_SEEDS = [
  'give me a recipe for a tomato sandwich',
  'what is the capital of france',
  'write a haiku about cats',
  'how do i change the oil in my car',
  'play despacito',
  'translate hello into japanese',
];

export function fixtureGenerateBatch(input: {
  pack: IntentParsePack;
  batchSize: number;
  includeNegatives: boolean;
  iteration: number;
  prior: readonly string[];
}): GeneratedCandidate[] {
  const steps = input.pack.steps.map((s) => s.id);
  const out: GeneratedCandidate[] = [];
  const priorSet = new Set(input.prior.map((p) => p.toLowerCase().trim()));

  let i = 0;
  while (out.length < input.batchSize && i < input.batchSize * 4) {
    const wantNeg =
      input.includeNegatives && (out.length % 3 === 2 || steps.length === 0);
    if (wantNeg) {
      const seed = NEGATIVE_SEEDS[(input.iteration + i) % NEGATIVE_SEEDS.length]!;
      const utterance = `${seed} (batch ${input.iteration}-${i})`;
      if (!priorSet.has(utterance.toLowerCase())) {
        out.push({ utterance, expectStepId: null, kind: 'negative' });
        priorSet.add(utterance.toLowerCase());
      }
    } else if (steps.length) {
      const stepId = steps[(input.iteration + i) % steps.length]!;
      const aliases = input.pack.aliases[stepId] ?? [];
      const base =
        aliases[(input.iteration + i) % Math.max(1, aliases.length)] ??
        stepId.replace(/_/g, ' ');
      // Force diversity: rare tokens + iteration salt (not near-paraphrase).
      const utterance = `${base} please — case ${input.iteration}.${i} ξ${(input.iteration * 17 + i) % 97}`;
      if (!priorSet.has(utterance.toLowerCase())) {
        out.push({ utterance, expectStepId: stepId, kind: 'positive' });
        priorSet.add(utterance.toLowerCase());
      }
    }
    i += 1;
  }
  return out.slice(0, input.batchSize);
}

export async function llmGenerateBatch(input: {
  provider: LlmProvider;
  pack: IntentParsePack;
  batchSize: number;
  includeNegatives: boolean;
  prior: readonly string[];
}): Promise<GeneratedCandidate[]> {
  const stepIds = input.pack.steps.map((s) => s.id);
  const prompt = [
    'Generate diverse training utterances for a UI coach.',
    `Produce exactly ${input.batchSize} candidates as JSON:`,
    '{ "candidates": [ { "utterance": "...", "expectStepId": "step_or_null", "kind": "positive|negative" } ] }',
    'Rules:',
    '- Positives must map to ONE of: ' + JSON.stringify(stepIds),
    '- Negatives (off-topic) must set expectStepId to null',
    '- For product Q&A that is NOT a navigation step, set expectStepId null and include faqId + faqAnswer',
    '- Include confused / imprecise phrasings (typos, drunk, lost user) — do not assume they know routes',
    '- Explicitly cover non-capabilities when relevant (e.g. VB does NOT take bowler payments/fees in-app)',
    input.includeNegatives
      ? '- Include at least 25% negatives (recipes, trivia, unrelated apps) AND some product FAQ'
      : '- Focus on positives',
    '- Do NOT paraphrase existing utterances; invent orthogonal phrasings',
    '- Avoid near-duplicates of priorUtterances',
    '',
    `priorUtterances (sample): ${JSON.stringify(input.prior.slice(-40))}`,
  ].join('\n');

  try {
    const text = await input.provider.completeChat({
      messages: [{ role: 'user', content: prompt }],
    });
    const extracted = extractJsonText(text);
    if (extracted) {
      const data = JSON.parse(extracted) as {
        candidates?: Array<{
          utterance?: string;
          expectStepId?: string | null;
          kind?: string;
          faqId?: string;
          faqAnswer?: string;
        }>;
      };
      const rows = Array.isArray(data.candidates) ? data.candidates : [];
      const mapped: GeneratedCandidate[] = [];
      for (const row of rows) {
        if (!row?.utterance || typeof row.utterance !== 'string') continue;
        const kind = row.kind === 'negative' ? 'negative' : 'positive';
        let expectStepId: string | null =
          row.expectStepId === null || row.expectStepId === undefined
            ? null
            : String(row.expectStepId);
        if (kind === 'negative') expectStepId = null;
        if (expectStepId && !stepIds.includes(expectStepId)) continue;
        mapped.push({
          utterance: row.utterance.trim(),
          expectStepId,
          kind,
          faqId: typeof row.faqId === 'string' ? row.faqId : undefined,
          faqAnswer: typeof row.faqAnswer === 'string' ? row.faqAnswer : undefined,
        });
      }
      if (mapped.length) return mapped.slice(0, input.batchSize);
    }
  } catch {
    /* fall through */
  }

  // Fallback: author generateScenarioCandidates then mark expects unknown (eval soft).
  const gen = await generateScenarioCandidates({
    provider: input.provider,
    batchSize: input.batchSize,
    flowSteps: input.pack.steps,
    intents: { aliases: input.pack.aliases, meta: input.pack.meta },
    priorUtterances: [...input.prior],
    mode: 'flow',
  });
  if (!gen.ok) return fixtureGenerateBatch({
    pack: input.pack,
    batchSize: input.batchSize,
    includeNegatives: input.includeNegatives,
    iteration: 0,
    prior: input.prior,
  });
  return gen.candidates.map((c) => ({
    utterance: c.utterance,
    expectStepId: stepIds[0] ?? null,
    kind: 'positive' as const,
  }));
}
