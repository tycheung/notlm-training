/**
 * Product training mode #2: `notlm-training feedback`
 * Live chat/miss logs → LLM drafts → accept → optional branch-out + ranker retrain.
 *
 * Legacy aliases: exchanges *, conversations *, misses *, metrics
 */
import { cmdPull, cmdDraft, cmdFold, cmdMetrics, takeFlag } from './cli.js';
import { cmdConversationsAnalyze, cmdConversationsPull } from './cmdConversations.js';
import {
  cmdMissesDraftAliases,
  cmdMissesExport,
  cmdMissesPull,
} from './cmdMisses.js';
import { cmdRankerTrain } from './cmdRanker.js';
import { cmdScenariosSaturate } from './cmdScenarios.js';
import { cmdPackAccept } from './commands.js';

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
}

/**
 * Subcommands:
 *   feedback pull --url …
 *   feedback draft --from …
 *   feedback fold --from …
 *   feedback conversations pull|analyze …
 *   feedback misses pull|export|draft-aliases …
 *   feedback metrics --from …
 *   feedback accept <draftId> [dir]
 *   feedback run --from <conv.json> …  (analyze; ranker only when pack was auto-accepted)
 */
export async function cmdFeedback(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === 'help' || sub === '--help') {
    console.log(`Usage:
  notlm-training feedback pull --url <endpoint> [--out <path>]
  notlm-training feedback draft --from <file> [dir]
  notlm-training feedback fold --from <draft.json> [dir]
  notlm-training feedback conversations pull|analyze …
  notlm-training feedback misses pull|export|draft-aliases …
  notlm-training feedback metrics --from <exchanges.json>
  notlm-training feedback accept <draftId> [dir]
  notlm-training feedback run --from <conv.json> [dir] [--mode=review|auto] [--branch-out] [--fixture]
`);
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
    else {
      console.error('Usage: feedback misses pull|export|draft-aliases …');
      process.exitCode = 1;
    }
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
    await cmdRankerTrain(dir ? [dir] : []);
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
    const analyzed = await cmdConversationsAnalyze(rest);
    if (!analyzed.ok) {
      // analyze already set exitCode / logged errors — do not ranker or branch-out.
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
      await cmdRankerTrain(analyzed.dir ? [analyzed.dir] : []);
    } else {
      console.log(
        'feedback → skip ranker (review mode; pack unchanged until accept)'
      );
    }
    return;
  }

  console.error(`Unknown feedback subcommand: ${sub}`);
  process.exitCode = 1;
}
