/**
 * System One sharpen loop (VB method):
 * generate N×13 lane prompts → score → patch pack language → iterate
 * until hardFails=0 or passRate >= target (default 0.999).
 */
import type { LlmProvider } from '@notlm/llm';
import type { PackJsonInput } from '@notlm/core';
import { CAPABILITY_LANES, type CapabilityLane } from './lanes.js';
import { generateFullSuite } from './generate.js';
import {
  applyPackPatch,
  proposePackPatch,
  writePackFolder,
  writeSharpenReport,
} from './patch.js';
import { loadStressPack, scoreSuite, type StressCase, type SuiteSummary } from './score.js';

export type SharpenConfig = {
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

export type SharpenReport = {
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
  stopReason: 'pass' | 'max_rounds' | 'no_failures' | 'stalled';
};

export const DEFAULT_SHARPEN: SharpenConfig = {
  perLane: 5000,
  passRate: 0.999,
  maxRounds: 20,
  fixture: false,
  writePack: true,
};

export function resolveSharpenConfig(
  partial: Partial<SharpenConfig> = {}
): SharpenConfig {
  return {
    perLane: partial.perLane ?? DEFAULT_SHARPEN.perLane,
    passRate: partial.passRate ?? DEFAULT_SHARPEN.passRate,
    maxRounds: partial.maxRounds ?? DEFAULT_SHARPEN.maxRounds,
    fixture: partial.fixture ?? DEFAULT_SHARPEN.fixture,
    writePack: partial.writePack ?? DEFAULT_SHARPEN.writePack,
    lanes: partial.lanes,
  };
}

function meetsTarget(summary: SuiteSummary, target: number): boolean {
  return summary.hardFails === 0 || summary.passRate >= target;
}

export async function runSharpenLoop(input: {
  pack: PackJsonInput;
  packDir: string;
  reportDir: string;
  provider?: LlmProvider | null;
  config?: Partial<SharpenConfig>;
  /** Injected suite (tests); skips generate when set. */
  cases?: StressCase[];
  onLog?: (msg: string) => void;
}): Promise<SharpenReport> {
  const config = resolveSharpenConfig(input.config);
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

  const history: SharpenReport['history'] = [];
  let round = 0;
  let lastFails = Number.POSITIVE_INFINITY;
  let stopReason: SharpenReport['stopReason'] = 'max_rounds';
  let final = scoreSuite(cases, loadStressPack(pack));

  history.push({
    round: 0,
    passRate: final.passRate,
    hardFails: final.hardFails,
    total: final.total,
  });
  log(
    `sharpen round=0 total=${final.total} passRate=${final.passRate.toFixed(4)} hardFails=${final.hardFails}`
  );

  if (meetsTarget(final, config.passRate)) {
    stopReason = final.hardFails === 0 ? 'no_failures' : 'pass';
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
        `sharpen round=${round} passRate=${final.passRate.toFixed(4)} hardFails=${final.hardFails}`
      );

      if (meetsTarget(final, config.passRate)) {
        stopReason = final.hardFails === 0 ? 'no_failures' : 'pass';
        break;
      }
      if (final.hardFails >= lastFails && round >= 2 && final.hardFails === lastFails) {
        if (fixedSuite) {
          stopReason = 'stalled';
          break;
        }
        log('sharpen stalled — regenerating suite');
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
          stopReason = final.hardFails === 0 ? 'no_failures' : 'pass';
          break;
        }
        stopReason = 'stalled';
        break;
      }
      lastFails = final.hardFails;
    }
  }

  const report: SharpenReport = {
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

  writeSharpenReport(input.reportDir, report);
  return report;
}
