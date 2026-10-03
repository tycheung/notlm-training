function jsonBlock(label: string, value: unknown): string {
  return `### ${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function buildPackAuthorPrompt(input: {
  inventory: unknown;
  structuredDraft: unknown;
}): string {
  return [
    'You are a notlm pack author.',
    'Given a control inventory and a structured DAG draft, propose pack JSON pieces.',
    'Respond with a single JSON object only (no markdown prose). Keys may include:',
    'manifest, flow, controls, intents, binders, corpus.',
    'Rules:',
    '- flow steps must include id, title, kind, requires',
    '- intents.aliases must be an object mapping stepId → string[]',
    '- binders must be an array of { stepId, path, op, value? } (or all/any)',
    '- Do not invent API keys or secrets',
    '',
    jsonBlock('inventory', input.inventory),
    '',
    jsonBlock('structuredDraft', input.structuredDraft),
  ].join('\n');
}

export {
  buildScenarioGeneratePrompt,
  buildSoftLabelPrompt,
} from './saturation/generatePrompt.js';

export function buildIntentTunePrompt(input: {
  currentIntents: unknown;
  scenarios: unknown;
  failingCases?: unknown;
  inventory?: unknown;
  flowSteps?: unknown;
}): string {
  const parts = [
    'You are tuning deterministic NLU intents for a notlm pack.',
    'Given current intents and labeled scenarios, propose improved intents + corpus.',
    'Respond with a single JSON object only (no markdown prose) shaped as:',
    '{ "intents": { "aliases": { "step_id": ["phrase one", "phrase two"] }, "meta": ["whats_next","go_back"] },',
    '  "corpus": [ { "id": "c1", "utterance": "example phrase", "expect": { "stepId": "step_id" } } ] }',
    'Corpus items MUST use keys: id, utterance, expect (with stepId). Do not use text/input/expected.',
    'CRITICAL: aliases keys MUST be exact step ids from flowSteps (never invent step_id).',
    'Every scenario should become matchable via aliases/keywords — no runtime LLM.',
    '',
    jsonBlock('currentIntents', input.currentIntents),
    '',
    jsonBlock('scenarios', input.scenarios),
  ];
  if (input.flowSteps !== undefined) {
    parts.push('', jsonBlock('flowSteps', input.flowSteps));
  }
  if (input.failingCases !== undefined) {
    parts.push('', jsonBlock('failingCases', input.failingCases));
  }
  if (input.inventory !== undefined) {
    parts.push('', jsonBlock('inventory', input.inventory));
  }
  return parts.join('\n');
}

export function buildConversationAnalyzePrompt(input: {
  conversations: unknown;
  flowSteps: unknown;
  currentIntents?: unknown;
  currentFaq?: unknown;
}): string {
  const parts = [
    'You analyze full NotLM coach conversations (hits and misses) to improve intent classification.',
    'Each conversation has conversationId and turns with role, text, outcome (hit|miss|blocked|confirm|slot_ask|adapter), stepId, missKind.',
    'Propose pack updates from patterns across the full flow — not single Q/A pairs alone.',
    'Respond with a single JSON object only (no markdown prose) shaped as:',
    '{ "proposedAliases": { "exact_step_id": ["utterance", ...] },',
    '  "proposedFaq": [ { "id": "faq-1", "aliases": ["question"], "text": "answer", "stepId?: "optional" } ],',
    '  "proposedCorpus": [ { "utterance": "…", "expect": { "stepId": "exact_step_id_or_null" } } ],',
    '  "notes": "brief analysis of hit vs miss patterns" }',
    'Rules:',
    '- proposedAliases keys MUST be exact step ids from flowSteps (unknown → put under "_unknown_step" or corpus stepId null).',
    '- Prefer promoting successful hit utterances as aliases for their stepId.',
    '- Misses may become aliases only when the intended step is clear from later turns in the SAME conversation.',
    '- Refuse / blocked / unclear → corpus with stepId null; never invent step ids.',
    '- Do not invent secrets or product API calls.',
    '',
    jsonBlock('flowSteps', input.flowSteps),
    '',
    jsonBlock('conversations', input.conversations),
  ];
  if (input.currentIntents !== undefined) {
    parts.push('', jsonBlock('currentIntents', input.currentIntents));
  }
  if (input.currentFaq !== undefined) {
    parts.push('', jsonBlock('currentFaq', input.currentFaq));
  }
  return parts.join('\n');
}
