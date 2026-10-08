/**
 * CLI: notlm-training e2eauto
 * Browser-free audit/NLU learning loop against host `.notlm` scenario banks.
 * Writes pack aliases/FAQ into the host tree only; checkpoints each lesson.
 */
import { join } from 'node:path';
import {
  loadPackJsonFromFolder,
  resolvePackFolder,
  readE2eConfigFromHome,
  resolveE2eAutoConfig,
  runE2eAutoLoop,
  DEFAULT_E2E_SOURCES,
} from '@notlm-training/author';
import {
  resolveNotlmHome,
  pathExists,
  ensureDir,
} from './notlmHome.js';
import { takeFlag, hasFlag, positionalDir } from './cliFlags.js';

export async function cmdE2eAuto(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home}`);
    process.exitCode = 1;
    return;
  }

  const packDir = resolvePackFolder(
    pathExists(join(home, 'pack', 'manifest.json')) ? home : projectRoot
  );
  if (!pathExists(join(packDir, 'manifest.json'))) {
    console.error(`Missing pack manifest under ${packDir}`);
    process.exitCode = 1;
    return;
  }

  const fromHome = readE2eConfigFromHome(home);
  const sourcesFlag = takeFlag(args, '--sources');
  const sources = sourcesFlag
    ? sourcesFlag.split(',').map((s) => s.trim()).filter(Boolean)
    : fromHome.sources?.length
      ? fromHome.sources
      : [...DEFAULT_E2E_SOURCES];

  const fixture = hasFlag(args, '--fixture') || fromHome.fixture === true;
  const writePack = !hasFlag(args, '--no-write');
  const reshuffle = !hasFlag(args, '--once');
  const maxRounds = Number(
    takeFlag(args, '--max-rounds') ??
      (fromHome.maxRounds != null ? fromHome.maxRounds : reshuffle ? 0 : 1)
  );
  const maxLessons = Number(
    takeFlag(args, '--max-lessons') ?? fromHome.maxLessons ?? 0
  );
  const checkpointEvery = Number(
    takeFlag(args, '--checkpoint-every') ?? fromHome.checkpointEvery ?? 1
  );
  const retrainRankerEvery = Number(
    takeFlag(args, '--retrain-ranker-every') ??
      fromHome.retrainRankerEvery ??
      0
  );
  const pauseMs = Number(takeFlag(args, '--pause-ms') ?? fromHome.pauseMs ?? 0);
  const minF1 = Number(takeFlag(args, '--min-f1') ?? fromHome.minF1 ?? 0);
  const minF1Cases = Number(
    takeFlag(args, '--min-f1-cases') ?? fromHome.minF1Cases ?? 20
  );

  const config = resolveE2eAutoConfig({
    ...fromHome,
    sources,
    fixture,
    writePack,
    reshuffle,
    maxRounds,
    maxLessons,
    checkpointEvery,
    retrainRankerEvery,
    pauseMs,
    minF1,
    minF1Cases,
  });

  const reportDir = join(home, 'train-e2eauto');
  ensureDir(reportDir);

  const pack = loadPackJsonFromFolder(packDir);

  let lessonsSinceRanker = 0;
  const report = await runE2eAutoLoop({
    home,
    packDir,
    pack,
    config,
    onLog: (msg) => console.log(msg),
    onAfterLesson: async ({ lesson }) => {
      if (retrainRankerEvery <= 0) return;
      lessonsSinceRanker += 1;
      if (lessonsSinceRanker < retrainRankerEvery) return;
      lessonsSinceRanker = 0;
      try {
        const { cmdRankerTrain } = await import('./cmdRanker.js');
        console.log(`e2eauto ranker retrain after lesson ${lesson}`);
        await cmdRankerTrain([projectRoot]);
      } catch (err) {
        console.warn(
          `e2eauto ranker retrain skipped: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        stopReason: report.stopReason,
        rounds: report.rounds,
        lessons: report.lessons,
        gradeCounts: report.gradeCounts,
        f1: report.f1,
        reportDir,
      },
      null,
      2
    )
  );
  if (!report.ok && report.stopReason !== 'all_correct') {
    process.exitCode = 1;
  }
}
