function jsonBlock(label: string, value: unknown): string {
  return `### ${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export function buildPackAuthorPrompt(input: {
  inventory: unknown;
  structuredDraft: unknown;
}): string {
  return [
    'You are a uipilot pack author.',
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
    'You are tuning deterministic NLU intents for a uipilot pack.',
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
