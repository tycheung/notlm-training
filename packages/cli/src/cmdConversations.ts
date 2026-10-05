import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeConversations } from '@notlm-training/author';
import { createProviderFromEnv } from '@notlm-training/llm';
import {
  validateConversationRecordList,
  validateConversationTurnList,
} from '@notlm/schema';
import {
  loadConversationsFromJson,
  loadConversationsFromRaw,
  writeConversationFoldDraft,
} from '@notlm-training/recalibrate';
import { cmdPackAccept } from './cmdPackIntents.js';
import { loadPackFolderJson, resolveNotlmHome } from './notlmHome.js';

function takeFlag(args: string[], name: string): string | undefined {
  const eq = args.findIndex((a) => a.startsWith(`${name}=`));
  if (eq >= 0) return args[eq]!.slice(name.length + 1);
  const idx = args.findIndex((a) => a === name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function positionalDir(args: string[], skipFlags: string[]): string {
  const skip = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (skipFlags.includes(a)) {
      skip.add(a);
      if (args[i + 1] && !args[i + 1]!.startsWith('-')) skip.add(args[i + 1]!);
    } else if (skipFlags.some((f) => a.startsWith(`${f}=`))) {
      skip.add(a);
    } else if (a === '--fixture' || a === '--mode' || a.startsWith('--mode=')) {
      skip.add(a);
      if (a === '--mode' && args[i + 1]) skip.add(args[i + 1]!);
    }
  }
  return args.find((a) => !a.startsWith('-') && !skip.has(a)) ?? process.cwd();
}

export async function cmdConversationsPull(args: string[]): Promise<void> {
  const url = takeFlag(args, '--url');
  if (!url) {
    console.error(
      'Usage: notlm-training conversations pull --url <endpoint> [--out <path>]'
    );
    process.exitCode = 1;
    return;
  }
  const outPath = takeFlag(args, '--out');
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as unknown;

  let conversations;
  const asRecords = validateConversationRecordList(data);
  if (asRecords.ok) {
    conversations = loadConversationsFromJson(data);
  } else {
    const asTurns = validateConversationTurnList(data);
    if (asTurns.ok) {
      conversations = loadConversationsFromJson(data);
    } else if (Array.isArray(data)) {
      conversations = loadConversationsFromJson(data);
    } else {
      throw new Error(
        [...asRecords.errors, ...asTurns.errors].join('\n') || 'Invalid conversation dump'
      );
    }
  }

  const payload = `${JSON.stringify(conversations, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, payload, 'utf8');
    console.log(`Wrote ${conversations.length} conversations → ${outPath}`);
  } else {
    process.stdout.write(payload);
  }
}

export type ConversationsAnalyzeResult =
  | { ok: false }
  | { ok: true; accepted: boolean; draftId: string; dir: string };

export async function cmdConversationsAnalyze(
  args: string[]
): Promise<ConversationsAnalyzeResult> {
  const fromPath = takeFlag(args, '--from');
  if (!fromPath) {
    console.error(
      'Usage: notlm-training conversations analyze --from <conv.json> [dir] [--mode=review|auto] [--fixture]'
    );
    process.exitCode = 1;
    return { ok: false };
  }

  const modeRaw = takeFlag(args, '--mode') ?? 'review';
  const mode = modeRaw === 'auto' ? 'auto' : 'review';
  const fixture =
    args.includes('--fixture') || process.env.NOTLM_SATURATE_FIXTURE === '1';

  const dir = positionalDir(args, ['--from', '--mode']);
  const { home } = resolveNotlmHome(dir);
  if (!existsSync(home)) {
    mkdirSync(join(home, 'drafts'), { recursive: true });
    mkdirSync(join(home, 'pack'), { recursive: true });
  }

  const conversations = loadConversationsFromRaw(readFileSync(fromPath, 'utf8'));
  if (!conversations.length) {
    console.error('No conversations found in dump');
    process.exitCode = 1;
    return { ok: false };
  }

  const files = loadPackFolderJson(home);
  const flow = Array.isArray(files.flow) ? files.flow : [];
  const flowSteps = flow
    .filter((s): s is Record<string, unknown> => s != null && typeof s === 'object')
    .map((s) => ({
      id: String(s.id ?? ''),
      title: typeof s.title === 'string' ? s.title : undefined,
    }))
    .filter((s) => s.id);

  const provider = fixture
    ? {
        completeChat: async () =>
          JSON.stringify({
            proposedAliases: {},
            proposedFaq: [],
            proposedCorpus: [],
            notes: 'unused-fixture-provider',
          }),
      }
    : createProviderFromEnv();

  const result = await analyzeConversations({
    provider,
    conversations,
    flowSteps,
    currentIntents: files.intents,
    currentFaq: files.faq,
    fixture,
  });

  if (!result.ok) {
    const errDir = join(home, 'drafts', `conversations-errors-${Date.now()}`);
    mkdirSync(errDir, { recursive: true });
    writeFileSync(
      join(errDir, 'errors.json'),
      `${JSON.stringify({ errors: result.errors, checklist: result.checklist }, null, 2)}\n`
    );
    console.error(`Analyze failed; see ${errDir}/errors.json`);
    process.exitCode = 1;
    return { ok: false };
  }

  const { proposalDir, foldDir, draftId } = writeConversationFoldDraft(
    home,
    {
      note: result.proposal.notes,
      proposedAliases: result.proposal.proposedAliases,
      proposedFaq: result.proposal.proposedFaq,
      proposedCorpus: result.proposal.proposedCorpus,
      conversations,
    },
    { checked: mode === 'auto' }
  );

  console.log(`Conversation proposal → ${proposalDir}`);
  console.log(`Folded pack draft → ${foldDir} (mode=${mode})`);

  if (mode === 'auto') {
    await cmdPackAccept(draftId, dir);
    console.log(
      'Auto-accepted. Next: run `notlmCLI intents check` on the project to gate scenarios.'
    );
    return { ok: true, accepted: true, draftId, dir };
  }

  console.log(
    'Review fold draft, set meta.checked=true, then: notlm-training pack accept ' +
      `${draftId} && notlmCLI intents check`
  );
  return { ok: true, accepted: false, draftId, dir };
}
