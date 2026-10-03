import type { ConversationRecord } from '@notlm/core';
import type { LlmProvider } from '@notlm/llm';
import { buildConversationAnalyzePrompt } from './prompts.js';
import { extractJsonText } from './parseModelJson.js';

export type ConversationAnalyzeProposal = {
  proposedAliases: Record<string, string[]>;
  proposedFaq: Array<{ id: string; aliases: string[]; text: string; stepId?: string }>;
  proposedCorpus: Array<{ utterance: string; expect: { stepId: string | null } }>;
  notes?: string;
};

export type AnalyzeConversationsResult =
  | { ok: true; proposal: ConversationAnalyzeProposal; raw: Record<string, unknown> }
  | { ok: false; errors: string[]; checklist: string[]; raw?: Record<string, unknown> };

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function normalizeProposal(
  raw: Record<string, unknown>,
  knownStepIds: Set<string>
): ConversationAnalyzeProposal {
  const proposedAliases: Record<string, string[]> = {};
  const aliasesRaw = raw.proposedAliases;
  if (aliasesRaw && typeof aliasesRaw === 'object' && !Array.isArray(aliasesRaw)) {
    for (const [stepId, texts] of Object.entries(aliasesRaw as Record<string, unknown>)) {
      const list = asStringArray(texts);
      if (!list.length) continue;
      const key = knownStepIds.has(stepId) ? stepId : '_unknown_step';
      proposedAliases[key] = [...(proposedAliases[key] ?? []), ...list];
    }
  }

  const proposedFaq: ConversationAnalyzeProposal['proposedFaq'] = [];
  if (Array.isArray(raw.proposedFaq)) {
    raw.proposedFaq.forEach((row, i) => {
      if (row == null || typeof row !== 'object' || Array.isArray(row)) return;
      const obj = row as Record<string, unknown>;
      const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : `conv-faq-${i + 1}`;
      const aliases = asStringArray(obj.aliases);
      const text = typeof obj.text === 'string' ? obj.text.trim() : '';
      if (!aliases.length || !text) return;
      const entry: ConversationAnalyzeProposal['proposedFaq'][number] = { id, aliases, text };
      if (typeof obj.stepId === 'string' && knownStepIds.has(obj.stepId)) {
        entry.stepId = obj.stepId;
      }
      proposedFaq.push(entry);
    });
  }

  const proposedCorpus: ConversationAnalyzeProposal['proposedCorpus'] = [];
  if (Array.isArray(raw.proposedCorpus)) {
    for (const row of raw.proposedCorpus) {
      if (row == null || typeof row !== 'object' || Array.isArray(row)) continue;
      const obj = row as Record<string, unknown>;
      const utterance = typeof obj.utterance === 'string' ? obj.utterance.trim() : '';
      if (!utterance) continue;
      const expectObj =
        obj.expect && typeof obj.expect === 'object' && !Array.isArray(obj.expect)
          ? (obj.expect as Record<string, unknown>)
          : {};
      let stepId: string | null =
        expectObj.stepId === null
          ? null
          : typeof expectObj.stepId === 'string'
            ? expectObj.stepId
            : null;
      if (stepId && !knownStepIds.has(stepId)) stepId = null;
      proposedCorpus.push({ utterance, expect: { stepId } });
    }
  }

  const notes = typeof raw.notes === 'string' ? raw.notes : undefined;
  return { proposedAliases, proposedFaq, proposedCorpus, ...(notes ? { notes } : {}) };
}

/** Deterministic fixture proposal for CI / --fixture (no LLM). */
export function fixtureConversationProposal(
  conversations: ConversationRecord[],
  knownStepIds: Set<string>
): ConversationAnalyzeProposal {
  const proposedAliases: Record<string, string[]> = {};
  const proposedCorpus: ConversationAnalyzeProposal['proposedCorpus'] = [];
  const proposedFaq: ConversationAnalyzeProposal['proposedFaq'] = [];

  for (const conv of conversations) {
    for (const turn of conv.turns) {
      if (turn.role !== 'user') continue;
      if (turn.outcome === 'hit' && turn.stepId && knownStepIds.has(turn.stepId)) {
        (proposedAliases[turn.stepId] ??= []).push(turn.text);
        proposedCorpus.push({ utterance: turn.text, expect: { stepId: turn.stepId } });
      } else if (turn.outcome === 'miss') {
        proposedCorpus.push({ utterance: turn.text, expect: { stepId: null } });
      }
    }
    const missUser = conv.turns.find((t) => t.role === 'user' && t.outcome === 'miss');
    const assist = conv.turns.find((t) => t.role === 'assistant');
    if (missUser && assist) {
      proposedFaq.push({
        id: `conv-faq-${conv.conversationId.slice(0, 8)}`,
        aliases: [missUser.text],
        text: assist.text,
      });
    }
  }

  // Dedupe alias lists
  for (const [k, list] of Object.entries(proposedAliases)) {
    proposedAliases[k] = [...new Set(list.map((t) => t.trim()).filter(Boolean))];
  }

  return {
    proposedAliases,
    proposedFaq,
    proposedCorpus,
    notes: 'fixture: promoted hit utterances as aliases; miss→corpus null + faq stubs',
  };
}

export async function analyzeConversations(input: {
  provider: LlmProvider;
  conversations: ConversationRecord[];
  flowSteps: Array<{ id: string; title?: string }>;
  currentIntents?: unknown;
  currentFaq?: unknown;
  fixture?: boolean;
}): Promise<AnalyzeConversationsResult> {
  const knownStepIds = new Set(input.flowSteps.map((s) => s.id));

  if (input.fixture) {
    return {
      ok: true,
      proposal: fixtureConversationProposal(input.conversations, knownStepIds),
      raw: { fixture: true },
    };
  }

  const prompt = buildConversationAnalyzePrompt({
    conversations: input.conversations,
    flowSteps: input.flowSteps,
    currentIntents: input.currentIntents,
    currentFaq: input.currentFaq,
  });

  const text = await input.provider.completeChat({
    messages: [
      {
        role: 'system',
        content:
          'Return JSON only with keys proposedAliases, proposedFaq, proposedCorpus, notes.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const extracted = extractJsonText(text);
  if (!extracted) {
    return {
      ok: false,
      errors: ['Could not extract JSON from model output'],
      checklist: ['Re-prompt for JSON only with proposedAliases/proposedFaq/proposedCorpus'],
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
      errors: ['Expected JSON object'],
      checklist: ['Model must return { proposedAliases, proposedFaq, proposedCorpus }'],
    };
  }

  const raw = parsed as Record<string, unknown>;
  const proposal = normalizeProposal(raw, knownStepIds);
  return { ok: true, proposal, raw };
}
