/**
 * Grade evaluate outcome vs host scenario expect (audit-style rubric).
 */
import {
  addConfusion,
  confusionForLabelMatch,
  emptyConfusion,
  f1FromConfusion,
  type BinaryConfusion,
  type F1Score,
} from '@notlm/core';
import type { E2eCase, E2eGrade, E2eGraded, E2eOutcome } from './types.js';

const EMPTY_GRADES = (): Record<E2eGrade, number> => ({
  Correct: 0,
  Partly: 0,
  Wrong: 0,
  NoReply: 0,
  LayaRisk: 0,
  Hallucinated: 0,
});

export { EMPTY_GRADES };

function wantsFaq(c: E2eCase): boolean {
  return typeof c.expect.faqId === 'string' && c.expect.faqId.length > 0;
}

export function gradeOutcome(c: E2eCase, outcome: E2eOutcome): E2eGraded {
  const reasons: string[] = [];
  let grade: E2eGrade = 'Correct';

  // Explicit fallthrough cases: strong FAQ must miss (handoff fixtures).
  if (c.expect.fallthrough) {
    if (outcome.strongFaqId) {
      grade = 'Wrong';
      reasons.push(`expected fallthrough but strong FAQ=${outcome.strongFaqId}`);
    } else {
      grade = 'Correct';
      reasons.push('fallthrough as expected (no strong FAQ)');
    }
    return finish(c, outcome, grade, reasons);
  }

  // OOD expects refuse / no product FAQ steal.
  if (c.expect.ood) {
    if (outcome.strongFaqId || outcome.stepId) {
      grade = 'Wrong';
      reasons.push(
        `OOD stole product path faq=${outcome.strongFaqId} step=${outcome.stepId}`
      );
    } else if (outcome.ood || outcome.replyStub) {
      grade = 'Correct';
      reasons.push('OOD refused locally');
    } else {
      grade = 'NoReply';
      reasons.push('OOD expected but empty outcome');
    }
    return finish(c, outcome, grade, reasons);
  }

  if (wantsFaq(c)) {
    const want = c.expect.faqId!;
    if (outcome.strongFaqId === want) {
      if (
        c.expect.stepId != null &&
        c.expect.stepId !== '' &&
        outcome.stepId &&
        outcome.stepId !== c.expect.stepId
      ) {
        grade = 'Partly';
        reasons.push(`FAQ ok; step ${outcome.stepId}≠${c.expect.stepId}`);
      } else {
        grade = 'Correct';
        reasons.push(`strong FAQ ${want}`);
      }
    } else if (outcome.weakFaqId === want && !outcome.strongFaqId) {
      grade = 'LayaRisk';
      reasons.push(
        `weak FAQ ${want} only — would fall through past strong gate toward Laya`
      );
    } else if (outcome.strongFaqId && outcome.strongFaqId !== want) {
      grade = 'Wrong';
      reasons.push(`strong FAQ ${outcome.strongFaqId}≠${want}`);
    } else if (outcome.stepId && !outcome.strongFaqId) {
      grade = 'Wrong';
      reasons.push(`FAQ expected; got step ${outcome.stepId}`);
    } else if (outcome.ood) {
      grade = 'Wrong';
      reasons.push('FAQ expected; cleared as OOD');
    } else if (!outcome.replyStub && !outcome.strongFaqId && !outcome.weakFaqId) {
      grade = 'NoReply';
      reasons.push('no FAQ / step / OOD hit');
    } else {
      grade = 'Partly';
      reasons.push(
        `missed strong FAQ ${want}; weak=${outcome.weakFaqId} step=${outcome.stepId}`
      );
    }
    return finish(c, outcome, grade, reasons);
  }

  if (typeof c.expect.stepId === 'string' && c.expect.stepId) {
    if (outcome.stepId === c.expect.stepId) {
      grade = 'Correct';
      reasons.push(`step ${c.expect.stepId}`);
    } else if (outcome.strongFaqId) {
      grade = 'Partly';
      reasons.push(`wanted step; got FAQ ${outcome.strongFaqId}`);
    } else if (!outcome.stepId) {
      grade = 'NoReply';
      reasons.push('no step hit');
    } else {
      grade = 'Wrong';
      reasons.push(`step ${outcome.stepId}≠${c.expect.stepId}`);
    }
    return finish(c, outcome, grade, reasons);
  }

  if (typeof c.expect.rawIntent === 'string' && c.expect.rawIntent) {
    if (outcome.rawIntent === c.expect.rawIntent) {
      grade = 'Correct';
      reasons.push(`intent ${c.expect.rawIntent}`);
    } else {
      grade = 'Wrong';
      reasons.push(`intent ${outcome.rawIntent}≠${c.expect.rawIntent}`);
    }
    return finish(c, outcome, grade, reasons);
  }

  grade = 'NoReply';
  reasons.push('no expect fields to grade');
  return finish(c, outcome, grade, reasons);
}

function finish(
  c: E2eCase,
  outcome: E2eOutcome,
  grade: E2eGrade,
  reasons: string[]
): E2eGraded {
  const needsLearn =
    grade === 'Wrong' ||
    grade === 'NoReply' ||
    grade === 'LayaRisk' ||
    grade === 'Hallucinated' ||
    grade === 'Partly';
  return { case: c, outcome, grade, reasons, needsLearn };
}

/**
 * Map one graded case into micro confusion for FAQ/OOD F1.
 * - expect.faqId → gold label = faqId, pred = strongFaqId
 * - expect.ood / fallthrough → gold null (must not strong-hit), pred = strongFaqId
 * - expect.stepId only → gold/pred step ids
 */
export function confusionFromGraded(graded: E2eGraded): BinaryConfusion {
  const { case: c, outcome } = graded;
  if (c.expect.ood || c.expect.fallthrough) {
    return confusionForLabelMatch(null, outcome.strongFaqId);
  }
  if (typeof c.expect.faqId === 'string' && c.expect.faqId) {
    return confusionForLabelMatch(c.expect.faqId, outcome.strongFaqId);
  }
  if (typeof c.expect.stepId === 'string' && c.expect.stepId) {
    return confusionForLabelMatch(c.expect.stepId, outcome.stepId);
  }
  return emptyConfusion();
}

export function scoreF1FromGraded(rows: E2eGraded[]): F1Score {
  let c = emptyConfusion();
  for (const row of rows) {
    c = addConfusion(c, confusionFromGraded(row));
  }
  return f1FromConfusion(c);
}
