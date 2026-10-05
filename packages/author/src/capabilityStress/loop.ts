/**
 * System One auto loop (lane stress):
 * generate N×13 lane prompts → score → patch pack language → iterate
 * until hardFails=0 and passRate >= target (default 0.999).
 */
import type { LlmProvider } from '@notlm-training/llm';
import type { PackJsonInput } from '@notlm/core';
import { CAPABILITY_LANES, type CapabilityLane } from './lanes.js';
import { generateFullSuite } from './generate.js';
import {
  applyPackPatch,
  proposePackPatch,
  writePackFolder,
  writeAutoReport,
} from './patch.js';
import { loadStressPack, scoreSuite, type StressCase, type SuiteSummary } from './score.js';

export type AutoLoopConfig = {
  /** Utterances per lane (default 5000). */
  perLane: number;
  /** Target pass rate (default 0.999). */
  passRate: number;
  /** Max repair rounds after initial score (default 20). */
  maxRounds: number;
  /** Skip LLM; morph from pack seeds. */
  fixture: boolean;
  /** Persist pack writes after each improving round. */
  writePack: boolean;
  lanes?: CapabilityLane[];
};

export type AutoLoopReport = {
  ok: boolean;
  rounds: number;
  perLane: number;
  passRateTarget: number;
  final: SuiteSummary;
  history: Array<{
    round: number;
    passRate: number;
    hardFails: number;
    total: number;
  }>;
  stopReason: 'max_rounds' | 'no_failures' | 'stalled';
};

export const DEFAULT_AUTO: AutoLoopConfig = {
  perLane: 5000,
  passRate: 0.999,
  maxRounds: 20,
  fixture: false,
  writePack: true,
};

export function resolveAutoConfig(
  partial: Partial<AutoLoopConfig> = {}
): AutoLoopConfig {
  return {
    perLane: partial.perLane ?? DEFAULT_AUTO.perLane,
    passRate: partial.passRate ?? DEFAULT_AUTO.passRate,
    maxRounds: partial.maxRounds ?? DEFAULT_AUTO.maxRounds,
    fixture: partial.fixture ?? DEFAULT_AUTO.fixture,
    writePack: partial.writePack ?? DEFAULT_AUTO.writePack,
    lanes: partial.lanes,
  };
}

function meetsTarget(summary: SuiteSummary, target: number): boolean {
  // Never report success while hard fails remain — pass-rate alone is not enough.
  return summary.hardFails === 0 && summary.passRate >= target;
}

export async function runAutoLoop(input: {
  pack: PackJsonInput;
  packDir: string;
  reportDir: string;
  provider?: LlmProvider | null;
  config?: Partial<AutoLoopConfig>;
  /** Injected suite (tests); skips generate when set. */
  cases?: StressCase[];
  onLog?: (msg: string) => void;
}): Promise<AutoLoopReport> {
  const config = resolveAutoConfig(input.config);
  const log = input.onLog || (() => undefined);
  const lanes = config.lanes || [...CAPABILITY_LANES];

  let pack = input.pack;
  const fixedSuite = Boolean(input.cases);
  let cases =
    input.cases ||
    (await generateFullSuite({
      pack,
      perLane: config.perLane,
      provider: input.provider,
      fixture: config.fixture,
      lanes,
      onProgress: log,
    }));

  const history: AutoLoopReport['history'] = [];
  let round = 0;
  let lastFails = Number.POSITIVE_INFINITY;
  let stopReason: AutoLoopReport['stopReason'] = 'max_rounds';
  let final = scoreSuite(cases, loadStressPack(pack));

  history.push({
    round: 0,
    passRate: final.passRate,
    hardFails: final.hardFails,
    total: final.total,
  });
  log(
    `auto round=0 total=${final.total} passRate=${final.passRate.toFixed(4)} hardFails=${final.hardFails}`
  );

  if (meetsTarget(final, config.passRate)) {
    stopReason = 'no_failures';
  } else {
    while (round < config.maxRounds) {
      round += 1;
      const patch = await proposePackPatch({
        pack,
        summary: final,
        provider: input.provider,
        fixture: config.fixture,
      });
      pack = applyPackPatch(pack, patch);
      if (config.writePack) writePackFolder(input.packDir, pack);

      final = scoreSuite(cases, loadStressPack(pack));
      history.push({
        round,
        passRate: final.passRate,
        hardFails: final.hardFails,
        total: final.total,
      });
      log(
        `auto round=${round} passRate=${final.passRate.toFixed(4)} hardFails=${final.hardFails}`
      );

      if (meetsTarget(final, config.passRate)) {
        stopReason = 'no_failures';
        break;
      }
      if (final.hardFails >= lastFails && round >= 2 && final.hardFails === lastFails) {
        if (fixedSuite) {
          stopReason = 'stalled';
          break;
        }
        log('auto stalled — regenerating suite');
        cases = await generateFullSuite({
          pack,
          perLane: Math.min(config.perLane, config.fixture ? config.perLane : 200),
          provider: input.provider,
          fixture: config.fixture,
          lanes,
          onProgress: log,
        });
        final = scoreSuite(cases, loadStressPack(pack));
        history.push({
          round,
          passRate: final.passRate,
          hardFails: final.hardFails,
          total: final.total,
        });
        if (meetsTarget(final, config.passRate)) {
          stopReason = 'no_failures';
          break;
        }
        stopReason = 'stalled';
        break;
      }
      lastFails = final.hardFails;
    }
  }

  const report: AutoLoopReport = {
    ok: meetsTarget(final, config.passRate),
    rounds: round,
    perLane: config.perLane,
    passRateTarget: config.passRate,
    final,
    history,
    stopReason: meetsTarget(final, config.passRate)
      ? stopReason
      : round >= config.maxRounds
        ? 'max_rounds'
        : stopReason,
  };

  writeAutoReport(input.reportDir, report);
  return report;
}
