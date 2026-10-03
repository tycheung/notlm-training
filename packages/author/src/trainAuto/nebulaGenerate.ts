/**
 * Composer-style nebula generation for train-auto (no LLM required).
 * Drunk / imprecise / route-confused asks + FAQ (incl. explicit non-capabilities).
 */
import type { FaqEntry, IntentParsePack } from '@notlm/core';
import type { GeneratedCandidate } from './generate.js';

const CONFUSED_PREFIX = [
  'uhh',
  'umm',
  'idk',
  'wait',
  'hey so',
  'dude',
  'bro',
  'ok so like',
  'quick question',
  'i forgot',
  'im lost',
  'after beers',
  'my buddy said',
  'can somebody',
  'pls',
  'yo',
];

const CONFUSED_SUFFIX = [
  'thx',
  'please',
  'lol',
  'nothing works',
  'i clicked everything',
  'before they yell at me',
  'i guess',
  'help',
  '??',
];

const HOW_STEMS = [
  'how do i',
  'how does',
  'where do i',
  'where was',
  'what is',
  'whats',
  "what's",
  'why cant i',
  "why can't i",
  'why wont',
  "why won't",
  'when do i',
  'who do i',
  'can i',
  'do i need to',
  'is there a way to',
];

/** Explicit non-capabilities for Victory Bowling (answer: no / not in-app). */
export const VB_NON_FEATURE_FAQ: FaqEntry = {
  id: 'faq-payments-not-in-app',
  aliases: [
    'can i take payments from vb',
    'can i take payments from victory bowling',
    'can i collect fees in the app',
    'can i charge entry fees through vb',
    'does vb process credit cards',
    'can i take stripe payments in vb',
    'how do i invoice bowlers from vb',
    'can vb collect entry fees for me',
    'is there a payment gateway in victory bowling',
    'can i accept card payments inside the director app',
    'do you handle tournament fee payments',
    'can i bill teams from this software',
    'how do players pay me through vb',
    'is paypal built into victory bowling',
    'can i take venmo payments in the app',
  ],
  text:
    'No. Victory Bowling does not take tournament entry fees, side-pot cash, or card payments inside the app. Track who owes what with prize fund / reports; collect money outside VB (cash, Venmo, Stripe on your own, etc.). Subscription / tournament-pass billing for directors is under Subscription — that is your plan, not bowler entry fees.',
  href: '/director/help/faq#payments',
  label: 'Payments & fees',
};

const NON_FEATURE_ASKS = [
  'can i take payments from vb directly',
  'can i collect entry fees in victory bowling',
  'how do i charge bowlers credit cards here',
  'does this app process stripe payments',
  'can vb send invoices to teams',
  'where do i turn on paypal for entry fees',
  'can players pay me inside the director app',
  'is there a built-in payment gateway',
  'how do i take venmo through victory bowling',
  'can i escrow prize money in vb',
];

const OOD_ASKS = [
  'what time does the grocery store close',
  'play despacito on youtube',
  'remind me to water the plants',
  'write a haiku about bowling shoes',
  'how do i change the oil in my truck',
  'whats the weather in cleveland',
  'order pizza for the bowling center',
  'translate hello into japanese',
];

function salt(iteration: number, i: number): string {
  return `case${iteration}x${i}n${(iteration * 31 + i * 17) % 997}`;
}

function mangle(s: string, n: number): string {
  if (n % 5 === 0) return s.replace(/([aeiou])/i, (m) => (m === m.toUpperCase() ? 'E' : 'e'));
  if (n % 7 === 0) return s.replace(/\s+/g, ' ').trim();
  return s;
}

function pick<T>(arr: readonly T[], n: number): T {
  return arr[n % arr.length]!;
}

export type NebulaCandidate = GeneratedCandidate & {
  faqId?: string;
  faqAnswer?: string;
};

/**
 * Build a diverse batch: step aliases, FAQ (incl. non-features), OOD negatives.
 */
export function composerNebulaBatch(input: {
  pack: IntentParsePack;
  batchSize: number;
  iteration: number;
  prior: readonly string[];
  includeNegatives?: boolean;
}): NebulaCandidate[] {
  const prior = new Set(input.prior.map((p) => p.toLowerCase().trim()));
  const out: NebulaCandidate[] = [];
  const steps = input.pack.steps;
  const faq = input.pack.faq ?? [];
  let i = 0;
  const maxTries = input.batchSize * 12;

  while (out.length < input.batchSize && i < maxTries) {
    const slot = (input.iteration + i) % 10;
    let candidate: NebulaCandidate | null = null;

    if (slot === 0 || slot === 1) {
      // Confused step ask
      if (steps.length) {
        const step = steps[(input.iteration + i) % steps.length]!;
        const aliases = input.pack.aliases[step.id] ?? [];
        const base =
          aliases[(input.iteration + i) % Math.max(1, aliases.length)] ??
          step.title ??
          step.id.replace(/_/g, ' ');
        const stem = pick(HOW_STEMS, i + input.iteration);
        const pre = pick(CONFUSED_PREFIX, i * 3);
        const suf = pick(CONFUSED_SUFFIX, i * 5);
        const utterance = mangle(
          `${pre} ${stem} ${base} ${suf} ${salt(input.iteration, i)}`,
          i
        );
        candidate = {
          utterance: utterance.replace(/\s+/g, ' ').trim(),
          expectStepId: step.id,
          kind: 'positive',
        };
      }
    } else if (slot === 2 || slot === 3 || slot === 4) {
      // FAQ / product Q — including non-feature
      const useNon = i % 4 === 0;
      if (useNon) {
        const ask = pick(NON_FEATURE_ASKS, input.iteration + i);
        const utterance = mangle(
          `${pick(CONFUSED_PREFIX, i)} ${ask} ${pick(CONFUSED_SUFFIX, i + 1)} ${salt(input.iteration, i)}`,
          i
        );
        candidate = {
          utterance: utterance.replace(/\s+/g, ' ').trim(),
          expectStepId: null,
          kind: 'negative',
          faqId: VB_NON_FEATURE_FAQ.id,
          faqAnswer: VB_NON_FEATURE_FAQ.text,
        };
      } else if (faq.length) {
        const entry = faq[(input.iteration + i) % faq.length]!;
        const alias =
          entry.aliases[(input.iteration + i) % Math.max(1, entry.aliases.length)] ??
          entry.id;
        const utterance = mangle(
          `${pick(CONFUSED_PREFIX, i)} ${pick(HOW_STEMS, i)} ${alias} ${pick(CONFUSED_SUFFIX, i)} ${salt(input.iteration, i)}`,
          i
        );
        candidate = {
          utterance: utterance.replace(/\s+/g, ' ').trim(),
          expectStepId: entry.stepId ?? null,
          kind: entry.stepId ? 'positive' : 'negative',
          faqId: entry.id,
          faqAnswer: entry.text,
        };
      }
    } else if (slot === 5 && (input.includeNegatives !== false)) {
      const ask = pick(OOD_ASKS, input.iteration + i);
      candidate = {
        utterance: `${ask} (${salt(input.iteration, i)})`,
        expectStepId: null,
        kind: 'negative',
      };
    } else {
      // Route-confused: ask about a step using wrong vocabulary
      if (steps.length) {
        const step = steps[(input.iteration + i * 3) % steps.length]!;
        const other = steps[(input.iteration + i * 5 + 1) % steps.length]!;
        const utterance = mangle(
          `${pick(CONFUSED_PREFIX, i)} ${pick(HOW_STEMS, i)} ${other.title ?? other.id} but i mean ${step.title ?? step.id} ${salt(input.iteration, i)}`,
          i
        );
        candidate = {
          utterance: utterance.replace(/\s+/g, ' ').trim(),
          expectStepId: step.id,
          kind: 'positive',
        };
      }
    }

    i += 1;
    if (!candidate) continue;
    const key = candidate.utterance.toLowerCase();
    if (prior.has(key) || key.length < 8) continue;
    prior.add(key);
    out.push(candidate);
  }
  return out;
}
