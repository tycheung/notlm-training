import { join } from 'node:path';
import {
  draftConversationalCopy,
  resolvePackFolder,
} from '@notlm-training/author';
import { createProviderFromEnv } from '@notlm-training/llm';
import {
  draftsDir,
  ensureDir,
  loadPackFolderJson,
  pathExists,
  resolveActivePackDir,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';
import { hasFlag } from './cliFlags.js';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Drafts replies.json + FAQ + slot asks under drafts/ (build-time only). */
export async function cmdTalkDraft(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith('-'));
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const useFixture = hasFlag(args, '--fixture') || process.env.NOTLM_SATURATE_FIXTURE === '1';
  const packDir = resolveActivePackDir(home, projectRoot, resolvePackFolder);
  const files = loadPackFolderJson(home, packDir);
  const flow = Array.isArray(files.flow) ? files.flow : [];
  const stepTitles = flow
    .filter((s): s is { id: string; title: string } =>
      s != null && typeof s === 'object' && typeof (s as { id?: unknown }).id === 'string'
    )
    .map((s) => ({
      id: (s as { id: string }).id,
      title: String((s as { title?: string }).title ?? (s as { id: string }).id),
    }));

  const config = files.config as { author?: { productBlurb?: string; blurb?: string } } | undefined;
  const productBlurb =
    config?.author?.productBlurb?.trim() || config?.author?.blurb?.trim() || undefined;

  const provider = useFixture ? null : createProviderFromEnv();
  const result = await draftConversationalCopy({
    provider,
    fixture: useFixture || !provider,
    stepTitles,
    productBlurb,
  });

  if (!result.ok) {
    for (const e of result.errors) console.error(e);
    process.exitCode = 1;
    return;
  }

  const draftId = `talk-${stamp()}`;
  const outDir = join(draftsDir(home), draftId);
  ensureDir(outDir);
  if (result.replies) writeJsonFile(join(outDir, 'replies.json'), result.replies);
  if (result.faq) writeJsonFile(join(outDir, 'faq.json'), result.faq);
  if (result.slotAsks) writeJsonFile(join(outDir, 'slotAsks.json'), result.slotAsks);
  writeJsonFile(join(outDir, 'meta.json'), {
    id: draftId,
    kind: 'talk-draft',
    createdAt: new Date().toISOString(),
    fixture: useFixture || !provider,
    checked: false,
  });
  console.log(`Talk draft ? ${outDir}`);
}
