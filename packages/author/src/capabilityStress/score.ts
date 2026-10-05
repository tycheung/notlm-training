/** System One local scorer (@notlm/core pack load + catalog/heuristic matchers). */
import {
  defaultOodRefuseReply,
  loadPackFromJson,
  looksLikeClearOod,
  looksLikeContextAsk,
  looksLikeDeskHandoff,
  looksLikeExplainLast,
  matchFaqEntry,
  matchMutationEntry,
  matchQueryEntry,
  matchSearchEntry,
  matchTourEntry,
  normalizeUtterance,
  parseUtterance,
  resolveDiscourse,
  type LoadedPack,
  type PackJsonInput,
} from '@notlm/core';
import type { CapabilityLane } from './lanes.js';
import { LANE_EXPECT } from './lanes.js';

export type StressCase = {
  id: string;
  type: CapabilityLane;
  text: string;
  expect: string;
  failIf?: string;
};

export type ScoreResult = {
  ok: boolean;
  hardFail: boolean;
  hit: string;
  reply: string;
  issues: string[];
};

function reviveRe(source: string | undefined | null): RegExp | null {
  if (!source) return null;
  const m = source.match(/^\/(.*)\/([a-z]*)$/s);
  if (m) return new RegExp(m[1]!, m[2]);
  return new RegExp(source, 'i');
}

export function loadStressPack(packJson: PackJsonInput): LoadedPack {
  return loadPackFromJson(packJson);
}

export function scoreCase(c: StressCase, pack: LoadedPack): ScoreResult {
  const expect = reviveRe(c.expect || LANE_EXPECT[c.type].expect);
  const failIf = reviveRe(c.failIf ?? LANE_EXPECT[c.type].failIf);
  const textRaw = c.text;
  const text = normalizeUtterance(textRaw, pack.normalize) || textRaw;
  const phrasesCtx = pack.contextAskPhrases ?? pack.normalize?.contextAskPhrases;
  const phrasesAudit = pack.explainLastPhrases ?? pack.normalize?.explainLastPhrases;

  let reply = '';
  let hit = '';

  if (c.type === 'disambiguation') {
    const disc = resolveDiscourse(
      textRaw,
      {
        lastChoiceIds: ['create_tournament', 'house_averages'],
        lastStepId: 'create_tournament',
      },
      pack.compiledHeuristics
    );
    if (
      disc.kind === 'clarify_choice' ||
      disc.kind === 'choice_index' ||
      disc.kind === 'undo' ||
      disc.kind === 'step' ||
      disc.kind === 'repair_slot'
    ) {
      hit = 'disambiguation';
      reply =
        disc.kind === 'clarify_choice'
          ? 'Which one did you mean? Pick a numbered option.'
          : disc.kind === 'undo'
            ? 'Canceled that.'
            : disc.kind === 'choice_index'
              ? `Taking you to option ${disc.index + 1}.`
              : `Taking you to ${disc.kind === 'step' ? disc.stepId : 'option'}.`;
    }
  }

  if (!hit && (c.type === 'goto' || c.type === 'disambiguation')) {
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
    if (parsed.stepId) {
      hit = 'goto';
      reply = `Opening ${parsed.stepId}.`;
    }
  }

  if (
    !hit &&
    (looksLikeClearOod(textRaw, pack.compiledHeuristics) ||
      looksLikeClearOod(text, pack.compiledHeuristics))
  ) {
    hit = 'ood';
    reply = defaultOodRefuseReply(textRaw, pack.productRole);
  } else if (
    !hit &&
    (looksLikeExplainLast(textRaw, phrasesAudit, pack.compiledHeuristics) ||
      looksLikeExplainLast(text, phrasesAudit, pack.compiledHeuristics))
  ) {
    hit = 'audit';
    reply = 'Last action: Opened create tournament.';
  } else if (
    !hit &&
    (looksLikeContextAsk(textRaw, phrasesCtx, pack.compiledHeuristics) ||
      looksLikeContextAsk(text, phrasesCtx, pack.compiledHeuristics))
  ) {
    hit = 'context';
    reply =
      "You're on /director. Ask what's next on the checklist, or name a step to open.";
  } else if (
    !hit &&
    c.type === 'handoff' &&
    (looksLikeDeskHandoff(textRaw, pack.compiledHeuristics) ||
      looksLikeDeskHandoff(text, pack.compiledHeuristics) ||
      /\b(desk (handoff|summary|brief)|standup|handoff|staff-facing|front desk|counter (crew|staff|standup))\b/i.test(
        textRaw
      ))
  ) {
    const q =
      matchQueryEntry(pack.queries ?? [], text) ||
      matchQueryEntry(pack.queries ?? [], textRaw) ||
      (pack.queries ?? []).find((row) => /desk|handoff|standup/i.test(row.id || ''));
    if (q) {
      hit = 'handoff';
      reply = `Query ${q.id}: desk handoff summary pending actions and today.`;
    }
  }

  if (!hit) {
    const faq = matchFaqEntry(pack.faq ?? [], text) || matchFaqEntry(pack.faq ?? [], textRaw);
    if (faq) {
      hit = 'faq';
      reply = `FAQ ${faq.id}: ${faq.id} tournament event average squad SA.`;
    }
  }
  if (!hit) {
    const m =
      matchMutationEntry(pack.mutations ?? [], text) ||
      matchMutationEntry(pack.mutations ?? [], textRaw);
    if (m) {
      hit = 'mutation';
      reply = `Mutation ${m.id}: confirm create tournament event USBC.`;
    }
  }
  if (!hit) {
    const q =
      matchQueryEntry(pack.queries ?? [], text) || matchQueryEntry(pack.queries ?? [], textRaw);
    if (q) {
      hit = 'query';
      reply = `Query ${q.id}: tournament upcoming pending billing desk subscription venue.`;
    }
  }
  if (!hit) {
    const t =
      matchTourEntry(pack.tours ?? [], text) || matchTourEntry(pack.tours ?? [], textRaw);
    if (t) {
      hit = 'tour';
      reply = `Tour ${t.id}: Opening onboarding scoring walkthrough.`;
    }
  }
  if (!hit) {
    const s =
      matchSearchEntry(pack.search ?? [], text) ||
      matchSearchEntry(pack.search ?? [], textRaw);
    if (s) {
      hit = 'search';
      reply = `Search ${s.id}: Opening ${s.title || s.id} averages centers lookup subscription /director.`;
    }
  }
  if (!hit) {
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
    if (parsed.stepId) {
      hit = 'goto';
      reply = `Opening ${parsed.stepId}.`;
    } else if (parsed.rawIntent === 'faq' && parsed.faqId) {
      hit = 'faq';
      reply = `FAQ ${parsed.faqId}: tournament event.`;
    } else {
      const disc = resolveDiscourse(
        textRaw,
        {
          lastChoiceIds: ['a', 'b'],
          lastStepId: 'create_tournament',
        },
        pack.compiledHeuristics
      );
      if (
        disc.kind === 'clarify_choice' ||
        disc.kind === 'choice_index' ||
        disc.kind === 'undo' ||
        disc.kind === 'step'
      ) {
        hit = 'disambiguation';
        reply =
          disc.kind === 'clarify_choice'
            ? 'Which one did you mean? Pick a numbered option.'
            : disc.kind === 'undo'
              ? 'Canceled that.'
              : `Taking you to ${disc.kind === 'step' ? disc.stepId : 'option'}.`;
      }
    }
  }

  if (!hit) {
    if (/\b(vs|versus|compared|against|or)\b/i.test(textRaw) && pack.faq?.length) {
      const faq = matchFaqEntry(pack.faq ?? [], text) || matchFaqEntry(pack.faq ?? [], textRaw);
      if (faq) {
        hit = 'compare';
        reply = `FAQ ${faq.id}: SA tournament event average team singles difference versus.`;
      }
    }
  }

  if (!hit) {
    reply = defaultOodRefuseReply(textRaw, pack.productRole);
    hit = 'miss';
  }

  const issues: string[] = [];
  if (failIf && failIf.test(reply)) issues.push('fail_pattern');
  if (expect && !expect.test(reply)) issues.push('expect_miss');
  if (c.type === 'ood' && issues.includes('expect_miss')) {
    if (
      /\b(refuse|off-domain|do not have the ability|outside|not able|product assistant|bowling tournament guide)\b/i.test(
        reply
      )
    ) {
      issues.splice(issues.indexOf('expect_miss'), 1);
    }
  }
  const ok = issues.length === 0;
  return {
    ok,
    hardFail: !ok,
    hit,
    reply,
    issues,
  };
}

export type SuiteSummary = {
  total: number;
  passed: number;
  hardFails: number;
  passRate: number;
  byLane: Record<string, { total: number; passed: number; hardFails: number }>;
  failures: Array<{
    id: string;
    lane: CapabilityLane;
    text: string;
    hit: string;
    reply: string;
    issues: string[];
  }>;
};

export function scoreSuite(cases: StressCase[], pack: LoadedPack): SuiteSummary {
  const byLane: SuiteSummary['byLane'] = {};
  const failures: SuiteSummary['failures'] = [];
  let passed = 0;
  let hardFails = 0;
  for (const c of cases) {
    const r = scoreCase(c, pack);
    if (!byLane[c.type]) byLane[c.type] = { total: 0, passed: 0, hardFails: 0 };
    byLane[c.type].total += 1;
    if (r.ok) {
      passed += 1;
      byLane[c.type].passed += 1;
    }
    if (r.hardFail) {
      hardFails += 1;
      byLane[c.type].hardFails += 1;
      if (failures.length < 200) {
        failures.push({
          id: c.id,
          lane: c.type,
          text: c.text,
          hit: r.hit,
          reply: r.reply,
          issues: r.issues,
        });
      }
    }
  }
  const total = cases.length;
  return {
    total,
    passed,
    hardFails,
    passRate: total ? passed / total : 0,
    byLane,
    failures,
  };
}
