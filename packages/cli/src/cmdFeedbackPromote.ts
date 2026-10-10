/**
 * Unified feedback pipeline: misses (+ optional exchanges) → cluster/draft.
 * Embed/ranker/Laya run only with --post (default off until drafts are accepted).
 * Never auto-accepts unchecked drafts.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePackFolder } from '@notlm-training/author';
import {
  cmdMissesCluster,
  cmdMissesDraftAliases,
  cmdMissesPull,
} from './cmdMisses.js';
import { cmdPull } from './cli.js';
import { hasFlag, takeFlag, positionalDir, FEEDBACK_PATH_FLAGS } from './cliFlags.js';
import { exited } from './cliExit.js';
import { pathExists, resolveActivePackDir, resolveNotlmHome } from './notlmHome.js';
import { runPipelinePost, wantsLaya } from './pipelinePost.js';

export async function cmdFeedbackPromote(args: string[]): Promise<void> {
  const dir = positionalDir(args, FEEDBACK_PATH_FLAGS);
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home}`);
    process.exitCode = 1;
    return;
  }

  const url = takeFlag(args, '--url') ?? process.env.NOTLM_MISSES_URL;
  const from = takeFlag(args, '--from');
  const token = takeFlag(args, '--token') ?? process.env.NOTLM_MISSES_TOKEN;
  const skipPull = hasFlag(args, '--skip-pull') || Boolean(from);
  const skipCluster = hasFlag(args, '--skip-cluster');
  const skipDraft = hasFlag(args, '--skip-draft');
  // Default: skip post until accept. Opt-in with --post / --force-post.
  const runPost = hasFlag(args, '--post') || hasFlag(args, '--force-post');
  const laya = wantsLaya(args);
  const layaDryRun = hasFlag(args, '--laya-dry-run') || hasFlag(args, '--dry-run');

  const outDir = join(home, 'train-feedback');
  mkdirSync(outDir, { recursive: true });
  const missesPath = from ?? join(outDir, 'misses.json');

  console.log('feedback → promote pipeline (misses → drafts; post after accept)');

  if (!skipPull) {
    if (!url) {
      console.error(
        'feedback promote needs --url (or NOTLM_MISSES_URL), or --from <misses.json> / --skip-pull'
      );
      process.exitCode = 1;
      return;
    }
    console.log('feedback → pull misses');
    process.exitCode = 0;
    const pullArgs = ['--url', url, '--out', missesPath];
    if (token) pullArgs.push('--token', token);
    try {
      await cmdMissesPull(pullArgs);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    if (exited()) return;

    const exUrl = takeFlag(args, '--exchanges-url');
    if (exUrl) {
      const exOut = join(outDir, 'exchanges.json');
      const exArgs = ['--url', exUrl, '--out', exOut];
      if (token) exArgs.push('--token', token);
      console.log('feedback → pull exchanges');
      process.exitCode = 0;
      try {
        await cmdPull(exArgs);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      if (exited()) return;
    }
  } else {
    console.log(`feedback → using local misses ${missesPath}`);
  }

  if (!existsSync(missesPath)) {
    console.error(`Missing misses file: ${missesPath}`);
    process.exitCode = 1;
    return;
  }

  const strictCustom = hasFlag(args, '--strict-custom');
  if (!skipCluster) {
    console.log('feedback → misses cluster');
    process.exitCode = 0;
    const clusterArgs = ['--from', missesPath, projectRoot];
    if (strictCustom) clusterArgs.push('--strict-custom');
    await cmdMissesCluster(clusterArgs);
    if (strictCustom && exited()) return;
    // Soft custom failure: clear exit so draft-aliases still runs.
    process.exitCode = 0;
  }

  if (!skipDraft) {
    console.log('feedback → misses draft-aliases');
    process.exitCode = 0;
    await cmdMissesDraftAliases(['--from', missesPath, projectRoot]);
    if (exited()) return;
  }

  console.log(
    'feedback → drafts ready under .notlm/drafts/ (accept-gated; not auto-merged)'
  );
  console.log(
    'feedback → next: review drafts, then `feedback accept <draftId>` (runs embed/ranker post)'
  );

  if (runPost) {
    console.warn(
      'feedback → --post: running embed/ranker on current pack (drafts not yet merged)'
    );
    await runPipelinePost({
      home,
      packDir: resolveActivePackDir(home, projectRoot, resolvePackFolder),
      projectRoot,
      forceRanker: false,
      laya,
      layaDryRun,
    });
  }

  writeFileSync(
    join(outDir, 'promote-summary.json'),
    `${JSON.stringify(
      {
        missesPath,
        drafts: join(home, 'drafts'),
        note: 'Review drafts then: notlm-training feedback accept <draftId>',
        postRan: runPost,
        at: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}
