/**
 * Learn from a graded miss: target FAQ / step / context phrases on HOST pack only.
 */
import type { PackJsonInput } from '@notlm/core';
import {
  applyPackPatch,
  type PackPatch,
} from '../capabilityStress/patch.js';
import type { E2eGraded } from './types.js';

function uniqPush(list: string[], add: string[], cap = 80): string[] {
  const seen = new Set(list.map((s) => s.toLowerCase()));
  const out = [...list];
  for (const a of add) {
    const t = String(a || '').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Build a minimal pack patch for one graded miss.
 * Prefer expect.faqId / stepId — never dump into the first FAQ blindly.
 */
export function lessonPatchFromGraded(
  pack: PackJsonInput,
  graded: E2eGraded
): PackPatch {
  const text = graded.case.utterance.trim();
  if (!text) return { notes: 'empty utterance' };

  const patch: PackPatch = { notes: `e2eauto lesson ${graded.case.id} (${graded.grade})` };

  if (graded.case.expect.ood) {
    // OOD misses usually need heuristics — host heuristics.json may be extended later.
    // For now record nothing that steals product FAQ; leave pack unchanged.
    return { notes: 'ood lesson — no pack alias write' };
  }

  if (graded.case.expect.fallthrough) {
    return { notes: 'fallthrough lesson — no alias write' };
  }

  const faqId = graded.case.expect.faqId;
  if (typeof faqId === 'string' && faqId) {
    const exists = (pack.faq || []).some((f) => f.id === faqId);
    if (exists) {
      patch.faq = [{ id: faqId, aliases: [text] }];
    } else {
      // Create stub FAQ entry when host expect references a missing id.
      patch.faq = [
        {
          id: faqId,
          aliases: [text],
          text: `TODO: author answer for ${faqId}`,
        },
      ];
    }
    return patch;
  }

  const stepId = graded.case.expect.stepId;
  if (typeof stepId === 'string' && stepId) {
    patch.aliases = { [stepId]: [text] };
    return patch;
  }

  // Context-shaped asks without FAQ expect.
  if (/\b(what page|which tab|where am i|how many bowlers)\b/i.test(text)) {
    patch.contextAskPhrases = uniqPush([], [text], 40);
    return patch;
  }

  // Last resort: append to first FAQ if any (fixture-only safety).
  const fallbackFaq = pack.faq?.[0]?.id;
  if (fallbackFaq) {
    patch.faq = [{ id: fallbackFaq, aliases: [text] }];
  }
  return patch;
}

export function applyLesson(
  pack: PackJsonInput,
  graded: E2eGraded
): { pack: PackJsonInput; patch: PackPatch; applied: boolean } {
  const patch = lessonPatchFromGraded(pack, graded);
  const hasFaq = Boolean(patch.faq?.length);
  const hasAliases = Boolean(patch.aliases && Object.keys(patch.aliases).length);
  const hasCtx = Boolean(patch.contextAskPhrases?.length);
  const hasExplain = Boolean(patch.explainLastPhrases?.length);
  if (!hasFaq && !hasAliases && !hasCtx && !hasExplain) {
    return { pack, patch, applied: false };
  }
  applyPackPatch(pack, patch);
  return { pack, patch, applied: true };
}

/**
 * Append a scenario row into an in-memory list for host faq-scenarios persistence.
 */
export function upsertScenarioRow(
  rows: Array<Record<string, unknown>>,
  graded: E2eGraded
): Array<Record<string, unknown>> {
  const id = graded.case.id;
  const next = {
    id,
    utterance: graded.case.utterance,
    expect: { ...graded.case.expect },
  };
  const idx = rows.findIndex((r) => r.id === id);
  if (idx >= 0) {
    rows[idx] = next;
    return rows;
  }
  rows.push(next);
  return rows;
}
