/**
 * Primary entry: `notlm-training train`
 * Combines capability stress (`auto`) + e2eauto, then drift-gated embed/ranker
 * and optional Laya (`--laya=1`).
 */
import { resolvePackFolder } from '@notlm-training/author';
import { cmdAuto } from './cmdAuto.js';
import { cmdE2eAuto } from './cmdE2eAuto.js';
import { hasFlag, takeFlag, positionalDir } from './cliFlags.js';
import { exited } from './cliExit.js';
import { pathExists, resolveActivePackDir, resolveNotlmHome } from './notlmHome.js';
import { runPipelinePost, wantsLaya } from './pipelinePost.js';

export async function cmdTrain(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home}`);
    process.exitCode = 1;
    return;
  }

  const skipAuto = hasFlag(args, '--skip-auto');
  const skipE2e = hasFlag(args, '--skip-e2e');
  const skipPost = hasFlag(args, '--skip-post');
  const forceRanker = hasFlag(args, '--force-ranker');
  const continueOnError = hasFlag(args, '--continue-on-error');
  const laya = wantsLaya(args);
  const layaDryRun = hasFlag(args, '--laya-dry-run') || hasFlag(args, '--dry-run');
  const writePack = !hasFlag(args, '--no-write');

  const childArgs = args.filter(
    (a) =>
      ![
        '--skip-auto',
        '--skip-e2e',
        '--skip-post',
        '--force-ranker',
        '--continue-on-error',
        '--laya',
        '--laya=1',
        '--laya=true',
        '--laya=0',
        '--laya=false',
        '--laya-dry-run',
      ].includes(a) && !a.startsWith('--laya=')
  );

  console.log(
    `train → phases: ${[
      !skipAuto && 'auto',
      !skipE2e && 'e2eauto',
      !skipPost && 'post(embed|ranker|laya?)',
    ]
      .filter(Boolean)
      .join(' → ')}`
  );

  const phaseArgs = [...childArgs, '--skip-post'];
  let failed = false;

  if (!skipAuto) {
    console.log('train → auto (capability stress)');
    process.exitCode = 0;
    await cmdAuto(phaseArgs);
    if (exited()) {
      failed = true;
      if (!continueOnError) {
        console.error('train → stop after auto failure (pass --continue-on-error to proceed)');
        return;
      }
      console.warn('train → auto failed; continuing (--continue-on-error)');
      process.exitCode = 0;
    }
  }

  if (!skipE2e) {
    console.log('train → e2eauto (scenario audit/learn)');
    const e2eArgs = [...phaseArgs];
    if (
      !hasFlag(e2eArgs, '--once') &&
      takeFlag(e2eArgs, '--max-rounds') === undefined &&
      takeFlag(e2eArgs, '--max-lessons') === undefined
    ) {
      e2eArgs.push('--once');
    }
    process.exitCode = 0;
    await cmdE2eAuto(e2eArgs);
    if (exited()) {
      failed = true;
      if (!continueOnError) {
        console.error('train → stop after e2eauto failure (pass --continue-on-error to proceed)');
        return;
      }
      console.warn('train → e2eauto failed; continuing (--continue-on-error)');
      process.exitCode = 0;
    }
  }

  if (!skipPost && writePack) {
    const post = await runPipelinePost({
      home,
      packDir: resolveActivePackDir(home, projectRoot, resolvePackFolder),
      projectRoot,
      forceRanker,
      requireRanker: forceRanker,
      laya,
      layaDryRun,
    });
    if (!post.ok) failed = true;
  } else if (skipPost) {
    console.log('train → skip post (--skip-post)');
  } else {
    console.log('train → skip post (--no-write)');
  }

  if (failed) process.exitCode = 1;
}
