/**
 * Evaluate one utterance against pack System One — no browser, no Laya call.
 * Uses matchStrongFaqEntry (production FAQ gate) + parse + OOD heuristics.
 */
import {
  defaultOodRefuseReply,
  loadPackFromJson,
  looksLikeClearOod,
  looksLikeContextAsk,
  looksLikeExplainLast,
  looksLikeNavCommand,
  matchFaqEntry,
  matchStrongFaqEntry,
  normalizeUtterance,
  parseUtterance,
  type FaqEntry,
  type LoadedPack,
  type PackJsonInput,
} from '@notlm/core';
import type { E2eOutcome } from './types.js';

export function loadE2ePack(pack: PackJsonInput): LoadedPack {
  return loadPackFromJson(pack);
}

export function evaluateUtterance(
  utterance: string,
  pack: LoadedPack
): E2eOutcome {
  const textRaw = utterance.trim();
  const text = normalizeUtterance(textRaw, pack.normalize) || textRaw;
  const faq = pack.faq ?? [];
  // Mirror production dispatch: nav commands skip FAQ short-circuit.
  const nav = looksLikeNavCommand(textRaw, pack.compiledHeuristics);
  const strongRaw = matchStrongFaqEntry(faq, textRaw);
  const weak = matchFaqEntry(faq, textRaw);
  const phrasesCtx = pack.contextAskPhrases ?? pack.normalize?.contextAskPhrases;
  const phrasesAudit =
    pack.explainLastPhrases ?? pack.normalize?.explainLastPhrases;
  const ood = looksLikeClearOod(textRaw, pack.compiledHeuristics);
  const explainLast = looksLikeExplainLast(
    textRaw,
    phrasesAudit,
    pack.compiledHeuristics
  );
  const contextAsk = looksLikeContextAsk(
    textRaw,
    phrasesCtx,
    pack.compiledHeuristics
  );

  let stepId: string | null = null;
  let rawIntent: string | null = null;
  let parsedFaqId: string | null = null;
  try {
    const parsed = parseUtterance(textRaw, {
      steps: pack.steps,
      aliases: pack.aliases,
      meta: pack.meta,
      metaPatterns: pack.metaPatterns,
      faq: pack.faq,
      normalize: pack.normalize,
      lexicon: pack.lexicon,
      compiledHeuristics: pack.compiledHeuristics,
    });
    stepId = parsed.stepId ?? null;
    rawIntent = parsed.rawIntent ?? null;
    parsedFaqId =
      typeof (parsed as { faqId?: string }).faqId === 'string'
        ? (parsed as { faqId?: string }).faqId!
        : null;
  } catch {
    // Incomplete host flow (missing keywords) — still grade FAQ/OOD.
  }

  // Prefer parse routing: if parse claimed FAQ/step, trust that over raw FAQ scan.
  let strong: FaqEntry | null = null;
  if (parsedFaqId) {
    strong = faq.find((f) => f.id === parsedFaqId) ?? strongRaw;
  } else if (!nav && !stepId) {
    strong = strongRaw;
  }

  let replyStub = '';
  if (ood && !strong) {
    replyStub = defaultOodRefuseReply(textRaw, pack.productRole);
  } else if (strong?.text) {
    replyStub = strong.text;
  } else if (stepId) {
    replyStub = `goto:${stepId}`;
  } else if (weak?.text && !nav) {
    replyStub = weak.text;
  } else if (contextAsk) {
    replyStub = `context:${text}`;
  } else if (explainLast) {
    replyStub = 'explain_last';
  }

  return {
    strongFaqId: strong?.id ?? null,
    weakFaqId: nav || stepId ? null : (weak?.id ?? null),
    stepId,
    rawIntent,
    ood,
    explainLast,
    contextAsk,
    replyStub,
  };
}
