import { resolvePackFolder } from '@notlm-training/author';
import { cmdPull, cmdDraft, cmdFold, cmdMetrics, takeFlag } from './cli.js';
import { cmdConversationsAnalyze, cmdConversationsPull } from './cmdConversations.js';
import {
  cmdMissesCluster,
  cmdMissesDraftAliases,
  cmdMissesExport,
  cmdMissesPull,
  cmdPackEmbedIndex,
} from './cmdMisses.js';
import { cmdScenariosSaturate } from './cmdScenarios.js';
import { cmdPackAccept } from './commands.js';
import { hasFlag } from './cliFlags.js';
import { exited } from './cliExit.js';
import { cmdFeedbackPromote } from './cmdFeedbackPromote.js';
import { runPipelinePost, wantsLaya } from './pipelinePost.js';
import { resolveActivePackDir, resolveNotlmHome } from './notlmHome.js';

const FEEDBACK_SUBS = new Set([
  'promote',
  'pull',
  'draft',
  'fold',
  'metrics',
  'conversations',
  'misses',
  'embed-index',
  'accept',
  'run',
  'help',
  '--help',
]);

function printFeedbackHelp(): void {
  console.log(`Usage (entry point):
  notlm-training feedback [dir] [--url=…] [--from=misses.json]
    # promote: pull misses → cluster → draft-aliases (no pack merge)
    # post (embed/ranker) runs on: feedback accept <draftId>
    # optional: --post to run post on current pack without accepting drafts

Advanced subcommands:
  notlm-training feedback promote|pull|draft|fold|metrics|accept|run|conversations|misses|embed-index …
`);
}

export async function cmdFeedback(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === 'help' || sub === '--help') {
    printFeedbackHelp();
    return;
  }

  // Default promote: no sub, promote, or flags/path only.
  if (!sub || sub === 'promote' || sub.startsWith('--')) {
    const promoteArgs = sub === 'promote' ? rest : args;
    await cmdFeedbackPromote(promoteArgs);
    return;
  }

  // Bare path as first arg → promote with that dir.
  if (
    !FEEDBACK_SUBS.has(sub) &&
    (sub.includes('/') || sub.includes('\\') || sub === '.' || sub.startsWith('..'))
  ) {
    await cmdFeedbackPromote(args);
    return;
  }

  if (!FEEDBACK_SUBS.has(sub)) {
    console.error(`Unknown feedback subcommand: ${sub}`);
    printFeedbackHelp();
    process.exitCode = 1;
    return;
  }

  if (sub === 'pull') {
    await cmdPull(rest);
    return;
  }
  if (sub === 'draft') {
    await cmdDraft(rest);
    return;
  }
  if (sub === 'fold') {
    await cmdFold(rest);
    return;
  }
  if (sub === 'metrics') {
    await cmdMetrics(rest);
    return;
  }
  if (sub === 'conversations') {
    const csub = rest[0];
    if (csub === 'pull') await cmdConversationsPull(rest.slice(1));
    else if (csub === 'analyze') await cmdConversationsAnalyze(rest.slice(1));
    else {
      console.error('Usage: feedback conversations pull|analyze …');
      process.exitCode = 1;
    }
    return;
  }
  if (sub === 'misses') {
    const msub = rest[0];
    if (msub === 'pull') await cmdMissesPull(rest.slice(1));
    else if (msub === 'export') await cmdMissesExport(rest.slice(1));
    else if (msub === 'draft-aliases') await cmdMissesDraftAliases(rest.slice(1));
    else if (msub === 'cluster') await cmdMissesCluster(rest.slice(1));
    else {
      console.error('Usage: feedback misses pull|export|draft-aliases|cluster …');
      process.exitCode = 1;
    }
    return;
  }
  if (sub === 'embed-index') {
    await cmdPackEmbedIndex(rest);
    return;
  }
  if (sub === 'accept') {
    const draftId = rest.find((a) => !a.startsWith('-'));
    const dir = rest.filter((a) => !a.startsWith('-') && a !== draftId)[0];
    if (!draftId) {
      console.error('Usage: feedback accept <draftId> [dir]');
      process.exitCode = 1;
      return;
    }
    await cmdPackAccept(draftId, dir);
    if (exited()) return;
    const { home, projectRoot } = resolveNotlmHome(dir);
    // Soft ranker: FAQ/query-only accepts must not fail after pack merge when
    // there is no trainable goto surface (requireRanker stays for train --force-ranker).
    const post = await runPipelinePost({
      home,
      packDir: resolveActivePackDir(home, projectRoot, resolvePackFolder),
      projectRoot,
      forceRanker: true,
      laya: wantsLaya(rest),
      layaDryRun: hasFlag(rest, '--laya-dry-run') || hasFlag(rest, '--dry-run'),
    });
    if (!post.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'run') {
    const from = takeFlag(rest, '--from');
    if (!from) {
      console.error(
        'Usage: feedback run --from <conv.json> [dir] [--mode=review|auto] [--branch-out] [--fixture]'
      );
      process.exitCode = 1;
      return;
    }
    // Peek mode before analyze consumes --mode (do not key skip logs on exitCode).
    const modeEq = rest.find((a) => a.startsWith('--mode='));
    const modeIdx = rest.indexOf('--mode');
    const modeRaw =
      (modeEq ? modeEq.slice('--mode='.length) : undefined) ||
      (modeIdx >= 0 && rest[modeIdx + 1] && !rest[modeIdx + 1]!.startsWith('-')
        ? rest[modeIdx + 1]
        : undefined) ||
      'review';
    const analyzed = await cmdConversationsAnalyze(rest);
    if (!analyzed.ok) {
      console.log('feedback → run aborted (conversation analyze failed)');
      return;
    }
    if (hasFlag(rest, '--branch-out')) {
      if (!analyzed.accepted) {
        console.log(
          'feedback → skip branch-out (review mode; accept the draft first)'
        );
      } else {
        console.log('feedback → branch-out saturate around log contexts');
        await cmdScenariosSaturate(rest.filter((a) => a !== '--branch-out'));
      }
    }
    if (analyzed.accepted) {
      const { home, projectRoot } = resolveNotlmHome(analyzed.dir);
      const post = await runPipelinePost({
        home,
        packDir: resolveActivePackDir(home, projectRoot, resolvePackFolder),
        projectRoot,
        forceRanker: true,
        laya: wantsLaya(rest),
        layaDryRun: hasFlag(rest, '--laya-dry-run') || hasFlag(rest, '--dry-run'),
      });
      if (!post.ok) process.exitCode = 1;
    } else if (modeRaw === 'auto') {
      console.log(
        'feedback → skip post (auto-accept failed; pack unchanged)'
      );
    } else {
      console.log(
        'feedback → skip post (review mode; pack unchanged until accept)'
      );
    }
    return;
  }

  console.error(`Unknown feedback subcommand: ${sub}`);
  process.exitCode = 1;
}
