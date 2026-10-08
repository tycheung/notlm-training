/**
 * Endless (or bounded) e2eauto loop:
 * load cases → evaluate → grade → checkpoint → learn → write → next.
 * Mutates host `.notlm/pack` only; never sealed notlm/packs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackJsonInput } from '@notlm/core';
import type { LlmProvider } from '@notlm-training/llm';
import { writePackFolder, writeAutoReport } from '../capabilityStress/patch.js';
import {
  appendGradeLog,
  bumpGradeCount,
  checkpointPack,
  e2eReportDir,
  loadE2eState,
  saveE2eState,
} from './checkpoint.js';
import { evaluateUtterance, loadE2ePack } from './evaluate.js';
import {
  EMPTY_GRADES,
  confusionFromGraded,
  gradeOutcome,
  scoreF1FromGraded,
} from './grade.js';
import {
  DEFAULT_E2E_SOURCES,
  loadE2eCases,
  morphUtterance,
} from './loadCases.js';
import { applyLessonAsync, upsertScenarioRow } from './learn.js';
import type {
  E2eAutoConfig,
  E2eAutoReport,
  E2eCase,
  E2eGrade,
  E2eGraded,
} from './types.js';
import {
  addConfusion,
  emptyConfusion,
  f1FromConfusion,
  type BinaryConfusion,
} from '@notlm/core';

export const DEFAULT_E2E_AUTO: E2eAutoConfig = {
  sources: [...DEFAULT_E2E_SOURCES],
  maxRounds: 0,
  maxLessons: 0,
  fixture: true,
  writePack: true,
  checkpointEvery: 1,
  retrainRankerEvery: 0,
  reshuffle: true,
  pauseMs: 0,
  minF1: 0,
  minF1Cases: 20,
};

export function resolveE2eAutoConfig(
  partial: Partial<E2eAutoConfig> = {}
): E2eAutoConfig {
  return {
    sources: partial.sources?.length
      ? partial.sources
      : [...DEFAULT_E2E_AUTO.sources],
    maxRounds: partial.maxRounds ?? DEFAULT_E2E_AUTO.maxRounds,
    maxLessons: partial.maxLessons ?? DEFAULT_E2E_AUTO.maxLessons,
    fixture: partial.fixture ?? DEFAULT_E2E_AUTO.fixture,
    writePack: partial.writePack ?? DEFAULT_E2E_AUTO.writePack,
    checkpointEvery:
      partial.checkpointEvery ?? DEFAULT_E2E_AUTO.checkpointEvery,
    retrainRankerEvery:
      partial.retrainRankerEvery ?? DEFAULT_E2E_AUTO.retrainRankerEvery,
    reshuffle: partial.reshuffle ?? DEFAULT_E2E_AUTO.reshuffle,
    pauseMs: partial.pauseMs ?? DEFAULT_E2E_AUTO.pauseMs,
    minF1: partial.minF1 ?? DEFAULT_E2E_AUTO.minF1,
    minF1Cases: partial.minF1Cases ?? DEFAULT_E2E_AUTO.minF1Cases,
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function shuffle<T>(arr: T[], salt: number): T[] {
  const out = [...arr];
  let s = salt || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function loadScenarioBank(
  home: string,
  name: string
): Array<Record<string, unknown>> {
  const path = join(home, name);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

function saveScenarioBank(
  home: string,
  name: string,
  rows: Array<Record<string, unknown>>
): void {
  writeFileSync(join(home, name), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

export async function runE2eAutoLoop(input: {
  home: string;
  packDir: string;
  pack: PackJsonInput;
  config?: Partial<E2eAutoConfig>;
  /**
   * Optional LLM for lesson patches when config.fixture=false.
   * Used by local Composer file-bridge / HTTP providers — not required for fixture mode.
   */
  provider?: LlmProvider | null;
  /** Injected cases (tests). */
  cases?: E2eCase[];
  onLog?: (msg: string) => void;
  /** Optional hook after each lesson (e.g. ranker train). */
  onAfterLesson?: (info: {
    lesson: number;
    caseId: string;
    grade: E2eGrade;
  }) => void | Promise<void>;
  /** Cooperative cancel. */
  shouldStop?: () => boolean;
}): Promise<E2eAutoReport> {
  const config = resolveE2eAutoConfig(input.config);
  const log = input.onLog || (() => undefined);
  const reportDir = e2eReportDir(input.home);
  mkdirSync(reportDir, { recursive: true });

  let pack = input.pack;
  let state = loadE2eState(reportDir);
  let cases =
    input.cases ||
    loadE2eCases(input.home, config.sources).map((c, i) =>
      config.fixture
        ? c
        : {
            ...c,
            utterance: morphUtterance(c.utterance, state.round + i),
          }
    );

  if (!cases.length) {
    const report: E2eAutoReport = {
      ok: false,
      rounds: 0,
      lessons: 0,
      stopReason: 'queue_empty',
      gradeCounts: EMPTY_GRADES(),
      history: [],
    };
    writeAutoReport(reportDir, report);
    return report;
  }

  cases = shuffle(cases, state.round + 1);
  let cursor = state.cursor % cases.length;
  const gradeCounts = { ...EMPTY_GRADES(), ...state.lastGradeCounts };
  const history: E2eAutoReport['history'] = [];
  let stopReason: E2eAutoReport['stopReason'] = 'max_rounds';
  const correctThisSweep = new Set<string>();
  /** After a non-reshuffle sweep that learned, run one verify pass. */
  let verifyPassPending = false;
  let sweepGraded: E2eGraded[] = [];
  let totalConfusion: BinaryConfusion = emptyConfusion();
  let lastF1 = f1FromConfusion(emptyConfusion());

  const faqBank = loadScenarioBank(input.home, 'faq-scenarios.json');

  log(
    `e2eauto start cases=${cases.length} cursor=${cursor} lessons=${state.lessons} fixture=${config.fixture}`
  );

  while (true) {
    if (input.shouldStop?.()) {
      stopReason = 'interrupted';
      break;
    }
    if (config.maxRounds > 0 && state.round >= config.maxRounds) {
      stopReason = 'max_rounds';
      break;
    }
    if (config.maxLessons > 0 && state.lessons >= config.maxLessons) {
      stopReason = 'max_lessons';
      break;
    }

    if (cursor >= cases.length) {
      // End of sweep — score F1 for this pass.
      if (sweepGraded.length) {
        lastF1 = scoreF1FromGraded(sweepGraded);
        log(
          `e2eauto sweep F1=${lastF1.f1.toFixed(4)} P=${lastF1.precision.toFixed(4)} R=${lastF1.recall.toFixed(4)} n=${sweepGraded.length} tp=${lastF1.confusion.tp} fp=${lastF1.confusion.fp} fn=${lastF1.confusion.fn}`
        );
        if (
          config.minF1 > 0 &&
          sweepGraded.length >= config.minF1Cases &&
          lastF1.f1 >= config.minF1
        ) {
          stopReason = 'min_f1';
          break;
        }
      }
      sweepGraded = [];

      if (!config.reshuffle) {
        if (state.lessons > 0 && !verifyPassPending) {
          // One verify sweep after learning (still no endless morph).
          verifyPassPending = true;
          cases = input.cases || loadE2eCases(input.home, config.sources);
          cursor = 0;
          correctThisSweep.clear();
          log(`e2eauto verify-pass cases=${cases.length}`);
          continue;
        }
        stopReason =
          correctThisSweep.size >= cases.length ? 'all_correct' : 'queue_empty';
        break;
      }
      // Endless: morph + reshuffle and continue.
      cases = shuffle(
        (input.cases || loadE2eCases(input.home, config.sources)).map((c, i) => ({
          ...c,
          utterance: morphUtterance(c.utterance, state.round + i + state.lessons),
        })),
        state.round + state.lessons + 7
      );
      cursor = 0;
      correctThisSweep.clear();
      log(`e2eauto reshuffle cases=${cases.length} round=${state.round}`);
    }

    const c = cases[cursor]!;
    cursor += 1;
    state.round += 1;
    state.cursor = cursor;

    const loaded = loadE2ePack(pack);
    const outcome = evaluateUtterance(c.utterance, loaded);
    const graded = gradeOutcome(c, outcome);
    gradeCounts[graded.grade] = (gradeCounts[graded.grade] || 0) + 1;
    state.lastGradeCounts = gradeCounts;
    sweepGraded.push(graded);
    totalConfusion = addConfusion(totalConfusion, confusionFromGraded(graded));
    lastF1 = f1FromConfusion(totalConfusion);

    appendGradeLog(reportDir, {
      round: state.round,
      id: c.id,
      utterance: c.utterance,
      grade: graded.grade,
      reasons: graded.reasons,
      outcome,
      source: c.source,
      f1Running: lastF1.f1,
      confusion: lastF1.confusion,
    });

    let learned = false;
    let checkpointPath: string | undefined;

    if (graded.needsLearn && config.writePack) {
      if (
        config.checkpointEvery > 0 &&
        state.lessons % config.checkpointEvery === 0
      ) {
        checkpointPath = checkpointPack({
          reportDir,
          packDir: input.packDir,
          home: input.home,
          lesson: state.lessons + 1,
          pack,
          meta: {
            caseId: c.id,
            grade: graded.grade,
            utterance: c.utterance,
          },
        });
      }

      const { applied, patch } = await applyLessonAsync(pack, graded, {
        provider: input.provider,
        fixture: config.fixture,
      });
      if (applied) {
        writePackFolder(input.packDir, pack);
        if (c.expect.faqId) {
          upsertScenarioRow(faqBank, graded);
          saveScenarioBank(input.home, 'faq-scenarios.json', faqBank);
        }
        state.lessons += 1;
        learned = true;
        correctThisSweep.delete(c.id);
        log(
          `e2eauto lesson=${state.lessons} ${graded.grade} ${c.id} patch=${patch.notes || ''}`
        );
        await input.onAfterLesson?.({
          lesson: state.lessons,
          caseId: c.id,
          grade: graded.grade,
        });
      } else {
        log(`e2eauto skip-learn ${graded.grade} ${c.id} (${patch.notes})`);
      }
    } else if (!graded.needsLearn) {
      correctThisSweep.add(c.id);
      if (correctThisSweep.size >= cases.length && cases.length > 0) {
        stopReason = 'all_correct';
        history.push({
          round: state.round,
          caseId: c.id,
          grade: graded.grade,
          learned: false,
        });
        break;
      }
    }

    history.push({
      round: state.round,
      caseId: c.id,
      grade: graded.grade,
      learned,
      checkpoint: checkpointPath,
      f1: lastF1.f1,
    });

    saveE2eState(reportDir, state);
    await sleep(config.pauseMs);

    if (
      config.minF1 > 0 &&
      state.round >= config.minF1Cases &&
      lastF1.f1 >= config.minF1 &&
      lastF1.confusion.fp + lastF1.confusion.fn === 0
    ) {
      // Perfect running confusion + F1 target — safe mid-sweep stop.
      // (Partial sweeps with residual FN must finish the bank / end-of-sweep check.)
      stopReason = 'min_f1';
      break;
    }

    // Bounded single pass without reshuffle: stop after one full sweep with no lessons needed.
    if (
      !config.reshuffle &&
      config.maxRounds === 0 &&
      cursor >= cases.length &&
      !learned
    ) {
      // continue until queue_empty handler
    }
  }

  state.cursor = cursor;
  state.lastGradeCounts = gradeCounts;
  saveE2eState(reportDir, state);

  if (sweepGraded.length) {
    lastF1 = scoreF1FromGraded(sweepGraded);
  } else {
    lastF1 = f1FromConfusion(totalConfusion);
  }

  const report: E2eAutoReport = {
    ok:
      stopReason === 'all_correct' ||
      stopReason === 'min_f1' ||
      (gradeCounts.Wrong === 0 &&
        gradeCounts.NoReply === 0 &&
        gradeCounts.LayaRisk === 0),
    rounds: state.round,
    lessons: state.lessons,
    stopReason,
    gradeCounts,
    f1: {
      precision: lastF1.precision,
      recall: lastF1.recall,
      f1: lastF1.f1,
      support: lastF1.support,
      confusion: lastF1.confusion,
    },
    history,
  };
  writeAutoReport(reportDir, report);
  log(
    `e2eauto done stop=${stopReason} rounds=${report.rounds} lessons=${report.lessons} correct=${gradeCounts.Correct} F1=${lastF1.f1.toFixed(4)}`
  );
  return report;
}

export function readE2eConfigFromHome(home: string): Partial<E2eAutoConfig> {
  const path = join(home, 'config.json');
  if (!existsSync(path)) return {};
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
      e2eauto?: Partial<E2eAutoConfig>;
    };
    return cfg.e2eauto || {};
  } catch {
    return {};
  }
}
