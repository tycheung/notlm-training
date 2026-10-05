/**
 * 13 System One capability lanes — same contract as VB local stress matrices.
 * Host packs supply domain seeds; lane expect/failIf stay generic enough for scoring.
 */
export const CORE_CAPABILITY_LANES = [
  'faq',
  'goto',
  'query',
  'mutation',
  'mutation_high_risk',
  'context',
  'tour',
  'search',
  'ood',
  'disambiguation',
] as const;

/** All 13 lanes (core + compare, handoff, audit) for opt-in stress runs. */
export const CAPABILITY_LANES = [
  ...CORE_CAPABILITY_LANES,
  'compare',
  'handoff',
  'audit',
] as const;

export type CapabilityLane = (typeof CAPABILITY_LANES)[number];

export type LaneExpect = {
  /** RegExp source tested against synthetic reply text. */
  expect: string;
  failIf?: string;
};

/** Default expect/failIf (aligned with VB stress matrices). */
export const LANE_EXPECT: Record<CapabilityLane, LaneExpect> = {
  faq: {
    expect:
      'tournament|event|average|credit|pass|squad|prize|lock|payment|checklist|external|admin|imperson|SA|side|center|billing|subscription|read.?only|desk|format|pot|FAQ|product|workflow|step',
    failIf:
      'do not have the ability to help|outside the scope|apple pie|joke|capital of|world series',
  },
  goto: {
    expect:
      '^(On it|Opening|Continuing|Added|Next up|Queued|Plan:)|open|Opening|taking you|here|centers|averages|lookup|subscription|actions|format|report|score|prize|side|event|tournament|lane|participant|external|billing',
    failIf:
      'do not have the ability to help with (open|take|go|navigate|show|bring|jump|route|head|pull|switch|land|drop|get|launch|move)',
  },
  query: {
    expect:
      'Query |tournament|upcoming|pending|billing|desk|subscription|venue|schedule|plan|chore|host',
    failIf: 'do not have the ability to help',
  },
  mutation: {
    expect: 'Mutation |confirm|create|tournament|event|USBC|assign|prefill',
    failIf: 'do not have the ability to help',
  },
  mutation_high_risk: {
    expect: 'Mutation |confirm|USBC|assign|high',
    failIf: 'do not have the ability to help',
  },
  context: {
    expect:
      "You're on|/director|checklist|blocker|grey|gray|disabled|missing|required|incomplete|validation",
    failIf: 'do not have the ability to help|Opening ',
  },
  tour: {
    expect: 'Tour |Opening|onboarding|walkthrough|scoring|spotlight',
    failIf: 'do not have the ability to help',
  },
  search: {
    expect: 'Search |Opening|averages|centers|lookup|subscription|/director',
    failIf: 'do not have the ability to help',
  },
  compare: {
    expect: 'FAQ |SA|tournament|event|average|team|singles|difference|versus|vs',
    failIf: 'do not have the ability to help',
  },
  handoff: {
    expect: 'Query |handoff|standup|pending|today|summary|shift',
    failIf: 'do not have the ability to help|Opening ',
  },
  audit: {
    expect: 'Last action:|Opened|goto|navigation|coach|assistant',
    failIf: 'do not have the ability to help|Opening create',
  },
  ood: {
    expect:
      'refuse|off-domain|do not have the ability|outside|not able|product assistant|bowling tournament guide',
    failIf: 'Opening |Tour |Mutation |Query |FAQ ',
  },
  disambiguation: {
    expect:
      'Which one|Pick a numbered|Canceled|Taking you to|option|clarify|undo',
    failIf: 'do not have the ability to help',
  },
};

/**
 * Preset LLM pre-prompts per lane (VB sharpen method: distinct domain paraphrases).
 * Host productRole / pack catalog summaries are interpolated by the generator.
 */
export function laneGeneratePrePrompt(input: {
  lane: CapabilityLane;
  productRole: string;
  catalogDigest: string;
  count: number;
  avoidSamples: string[];
}): string {
  const avoid = input.avoidSamples.slice(0, 40);
  const laneJobs: Record<CapabilityLane, string> = {
    faq: 'product FAQ / conceptual questions a user would ask (not navigation commands)',
    goto: 'direct navigation / open / take-me-to commands for real pack steps',
    query: 'read-only data asks (schedule, billing status, pending chores, venues)',
    mutation: 'safe create / prefill write asks that should hit mutation catalog',
    mutation_high_risk: 'high-risk confirm-gated mutations (assign external ids, destructive)',
    context: 'page blocker / why-is-save-grey / what-am-I-missing asks',
    tour: 'walkthrough / onboarding / show-me-around asks',
    search: 'find / locate / search surface asks',
    compare: 'A vs B / difference / which-fits product compare asks',
    handoff: 'desk / standup / shift handoff summary asks',
    audit: 'what-did-you-just-do / explain-last / audit prior assistant action',
    ood: 'clearly off-domain asks that must be refused (jokes, recipes, trivia, unrelated)',
    disambiguation:
      'discourse repair: meant-the-other, number picks, cancel that choice, nevermind',
  };
  return [
    'You generate DISTINCT natural-language user utterances for NotLM System One stress.',
    `Product role: ${input.productRole}`,
    `Lane: ${input.lane} — ${laneJobs[input.lane]}`,
    `Generate exactly ${input.count} unique utterances (English).`,
    'Rules:',
    '- Each line must be a single utterance, no numbering, no quotes, no markdown.',
    '- Stay in-lane; do not mix OOD into goto/faq (except the ood lane).',
    '- Prefer paraphrases a real operator would say; vary length and politeness fillers.',
    '- Do not repeat any avoid-list item (normalize spaces/case when checking).',
    '',
    '### Pack catalog digest',
    input.catalogDigest.slice(0, 6000),
    '',
    avoid.length
      ? `### Avoid (already seen)\n${avoid.map((s) => `- ${s}`).join('\n')}`
      : '',
    '',
    'Respond with ONLY the utterances, one per line.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** LLM prompt to propose pack patches from hard fails. */
export function lanePatchPrePrompt(input: {
  productRole: string;
  failures: Array<{ lane: string; text: string; hit: string; reply: string }>;
  catalogDigest: string;
}): string {
  return [
    'You repair a NotLM pack so System One stress hard-fails become hits.',
    `Product role: ${input.productRole}`,
    'Respond with a single JSON object only:',
    '{',
    '  "aliases": { "exact_step_id": ["utterance", ...] },',
    '  "faq": [ { "id": "faq-id", "aliases": ["…"], "text": "…" } ],',
    '  "queryAliases": { "exact_query_id": ["…"] },',
    '  "mutationAliases": { "exact_mutation_id": ["…"] },',
    '  "tourAliases": { "exact_tour_id": ["…"] },',
    '  "searchAliases": { "exact_search_id": ["…"] },',
    '  "contextAskPhrases": ["…"],',
    '  "explainLastPhrases": ["…"],',
    '  "notes": "brief"',
    '}',
    'Rules: only use exact ids from the catalog digest; never invent steps.',
    'OOD fails usually need stronger ood heuristics (skip — host heuristics.json).',
    'Disambiguation fails usually need discourse fillers in heuristics/normalize.',
    '',
    '### Catalog digest',
    input.catalogDigest.slice(0, 8000),
    '',
    '### Failures',
    JSON.stringify(input.failures.slice(0, 80), null, 2),
  ].join('\n');
}
