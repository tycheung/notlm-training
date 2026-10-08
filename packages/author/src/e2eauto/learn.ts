/**
 * Learn from a graded miss: target FAQ / step / context phrases on HOST pack only.
 */
import {
  isStrongFaqAliasMatch,
  normalizeUtterance,
  type FaqEntry,
  type PackJsonInput,
} from '@notlm/core';
import type { LlmProvider } from '@notlm-training/llm';
import { extractJsonText } from '../parseModelJson.js';
import { catalogDigest } from '../capabilityStress/packLoad.js';
import {
  applyPackPatch,
  type PackPatch,
} from '../capabilityStress/patch.js';
import type { E2eGraded } from './types.js';

/** FAQ aliases that alone strong-match this utterance (steal step/nav). */
export function collidingFaqAliases(
  entry: FaqEntry | undefined,
  utterance: string
): string[] {
  if (!entry?.aliases?.length) return [];
  const out: string[] = [];
  for (const a of entry.aliases) {
    const label = String(a || '').trim();
    if (!label) continue;
    const solo: FaqEntry = {
      id: entry.id,
      aliases: [label],
      text: entry.text,
    };
    if (isStrongFaqAliasMatch(utterance, solo)) out.push(label);
  }
  return out;
}

/** Parse LLM PackPatch JSON (not a full pack folder — skip schema validate). */
function parsePackPatchJson(raw: string): PackPatch | null {
  const jsonText = extractJsonText(raw) ?? raw;
  try {
    const data = JSON.parse(jsonText) as unknown;
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      return null;
    }
    return data as PackPatch;
  } catch {
    return null;
  }
}

/** Prompt for an external LLM (e.g. Composer file-bridge) to propose one lesson patch. */
export function lessonPatchLlmPrompt(input: {
  productRole: string;
  graded: E2eGraded;
  catalogDigest: string;
}): string {
  const g = input.graded;
  return [
    'You repair a NotLM host pack so one graded e2eauto miss becomes a System One hit.',
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
    '  "faqRemoveAliases": [ { "id": "faq-id", "aliases": ["polluted alias"] } ],',
    '  "notes": "brief"',
    '}',
    'Rules:',
    '- Only use exact ids from the catalog digest; never invent steps/FAQ ids unless expect.faqId is missing from pack.',
    '- Prefer adding the failing utterance as an alias on the expected faqId/stepId.',
    '- If expect.stepId but a FAQ stole the hit: add step alias AND faqRemoveAliases for the colliding FAQ aliases.',
    '- OOD / fallthrough expects: return empty notes only — do not steal product FAQ.',
    '- Keep patches minimal (one target id).',
    '',
    '### Catalog digest',
    input.catalogDigest.slice(0, 8000),
    '',
    '### Graded miss',
    JSON.stringify(
      {
        id: g.case.id,
        utterance: g.case.utterance,
        expect: g.case.expect,
        grade: g.grade,
        reasons: g.reasons,
        outcome: {
          strongFaqId: g.outcome.strongFaqId,
          weakFaqId: g.outcome.weakFaqId,
          stepId: g.outcome.stepId,
          rawIntent: g.outcome.rawIntent,
          ood: g.outcome.ood,
          replyStub: g.outcome.replyStub.slice(0, 240),
        },
      },
      null,
      2
    ),
  ].join('\n');
}

function patchHasWrites(patch: PackPatch): boolean {
  return Boolean(
    patch.faq?.length ||
      patch.faqRemoveAliases?.length ||
      (patch.aliases && Object.keys(patch.aliases).length) ||
      (patch.aliasRemove && Object.keys(patch.aliasRemove).length) ||
      patch.contextAskPhrases?.length ||
      patch.explainLastPhrases?.length ||
      (patch.queryAliases && Object.keys(patch.queryAliases).length) ||
      (patch.mutationAliases && Object.keys(patch.mutationAliases).length) ||
      (patch.tourAliases && Object.keys(patch.tourAliases).length) ||
      (patch.searchAliases && Object.keys(patch.searchAliases).length)
  );
}

/**
 * Ask an LLM for a PackPatch; fall back to deterministic lessonPatchFromGraded.
 */
export async function proposeLessonPatch(input: {
  pack: PackJsonInput;
  graded: E2eGraded;
  provider?: LlmProvider | null;
  fixture?: boolean;
}): Promise<PackPatch> {
  const fallback = lessonPatchFromGraded(input.pack, input.graded);
  if (input.fixture || !input.provider) return fallback;

  const prompt = lessonPatchLlmPrompt({
    productRole: input.pack.manifest?.productRole || 'product assistant',
    graded: input.graded,
    catalogDigest: catalogDigest(input.pack),
  });
  try {
    const raw = await input.provider.completeChat({
      messages: [
        {
          role: 'system',
          content: 'Return only valid JSON pack patch for NotLM e2eauto.',
        },
        { role: 'user', content: prompt },
      ],
    });
    const patch = parsePackPatchJson(raw);
    if (patch) {
      if (!patch.notes) {
        patch.notes = `e2eauto llm lesson ${input.graded.case.id}`;
      }
      if (
        patchHasWrites(patch) ||
        input.graded.case.expect.ood ||
        input.graded.case.expect.fallthrough
      ) {
        return patch;
      }
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

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

  const textNorm = normalizeUtterance(text, pack.normalize) || text;
  const aliasForms = [...new Set([text, textNorm].filter(Boolean))];

  const faqId = graded.case.expect.faqId;
  if (typeof faqId === 'string' && faqId) {
    const exists = (pack.faq || []).some((f) => f.id === faqId);
    if (exists) {
      patch.faq = [{ id: faqId, aliases: aliasForms }];
    } else {
      // Create stub FAQ entry when host expect references a missing id.
      patch.faq = [
        {
          id: faqId,
          aliases: aliasForms,
          text: `TODO: author answer for ${faqId}`,
        },
      ];
    }
    // FAQ expect stolen by a step — demote that step's colliding aliases.
    const gotStep = graded.outcome.stepId;
    if (gotStep) {
      const wrongAls = pack.intents?.aliases?.[gotStep] || [];
      const removeAls = wrongAls.filter((a) => {
        const al = String(a).trim().toLowerCase();
        return aliasForms.some(
          (f) => al === f.toLowerCase() || (al.length >= 6 && f.toLowerCase().includes(al))
        );
      });
      if (removeAls.length) {
        patch.aliasRemove = { [gotStep]: removeAls };
        patch.notes = `${patch.notes}; demote step ${gotStep}`;
      }
    }
    return patch;
  }

  const stepId = graded.case.expect.stepId;
  if (typeof stepId === 'string' && stepId) {
    patch.aliases = { [stepId]: aliasForms };
    // Strong FAQ short-circuits parse before step aliases — strip the steal.
    const stealId = graded.outcome.strongFaqId;
    if (stealId) {
      const entry = (pack.faq || []).find((f) => f.id === stealId);
      const remove = collidingFaqAliases(entry, text);
      if (remove.length) {
        patch.faqRemoveAliases = [{ id: stealId, aliases: remove }];
        patch.notes = `${patch.notes}; strip ${stealId} collisions`;
      }
    }
    // Wrong step hit: drop this utterance from the incorrect step's aliases.
    const gotStep = graded.outcome.stepId;
    if (gotStep && gotStep !== stepId) {
      const wrongAls = pack.intents?.aliases?.[gotStep] || [];
      const removeAls = wrongAls.filter((a) => {
        const al = String(a).trim().toLowerCase();
        if (!al) return false;
        if (al === text.toLowerCase()) return true;
        return al.length >= 8 && text.toLowerCase().includes(al);
      });
      if (removeAls.length) {
        patch.aliasRemove = { [gotStep]: removeAls };
        patch.notes = `${patch.notes}; demote ${gotStep}`;
      }
    }
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
  if (!patchHasWrites(patch)) {
    return { pack, patch, applied: false };
  }
  applyPackPatch(pack, patch);
  return { pack, patch, applied: true };
}

/** Merge deterministic FAQ collision strips into an LLM patch when needed. */
function ensureStepFaqCollisionStrip(
  pack: PackJsonInput,
  graded: E2eGraded,
  patch: PackPatch
): PackPatch {
  const stepId = graded.case.expect.stepId;
  const stealId = graded.outcome.strongFaqId;
  if (typeof stepId !== 'string' || !stepId || !stealId) return patch;
  const entry = (pack.faq || []).find((f) => f.id === stealId);
  const remove = collidingFaqAliases(entry, graded.case.utterance.trim());
  if (!remove.length) return patch;
  const existing = patch.faqRemoveAliases || [];
  const byId = new Map(existing.map((r) => [r.id, new Set(r.aliases)]));
  const set = byId.get(stealId) || new Set<string>();
  for (const a of remove) set.add(a);
  byId.set(stealId, set);
  patch.faqRemoveAliases = [...byId.entries()].map(([id, aliases]) => ({
    id,
    aliases: [...aliases],
  }));
  if (!patch.aliases?.[stepId]?.length) {
    patch.aliases = {
      ...(patch.aliases || {}),
      [stepId]: [graded.case.utterance.trim()],
    };
  }
  return patch;
}

/** Like applyLesson, but may call an injected LlmProvider when fixture=false. */
export async function applyLessonAsync(
  pack: PackJsonInput,
  graded: E2eGraded,
  opts?: { provider?: LlmProvider | null; fixture?: boolean }
): Promise<{ pack: PackJsonInput; patch: PackPatch; applied: boolean }> {
  let patch = await proposeLessonPatch({
    pack,
    graded,
    provider: opts?.provider,
    fixture: opts?.fixture ?? true,
  });
  patch = ensureStepFaqCollisionStrip(pack, graded, patch);
  if (!patchHasWrites(patch)) {
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
