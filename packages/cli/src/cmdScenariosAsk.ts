import {
  createLabelerFromEnv,
  faqDraftFromSoftLabels,
  labelCandidates,
  resolveLabelerKind,
  tuneIntents,
} from '@notlm-training/author';
import { checkIntents } from '@notlm/core';
import { createProviderFromEnv } from '@notlm-training/llm';
import { join } from 'node:path';
import {
  draftsDir,
  ensureDir,
  loadPackFolderJson,
  pathExists,
  readJsonFile,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';
import { exited } from './cliExit.js';
import {
  hasFlag,
  loadPriorCandidates,
  parseFlag,
  parseForceCount,
  positionalDir,
  resolveProductBlurb,
  stamp,
} from './scenarioCliShared.js';
import { cmdScenariosGenerate } from './cmdScenarios.js';

export async function cmdScenariosLabelPool(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const chunk = Math.max(1, Number(parseFlag(args, '--chunk') ?? '50') || 50);
  const useFixture = hasFlag(args, '--fixture') || process.env.NOTLM_SATURATE_FIXTURE === '1';
  const files = loadPackFolderJson(home);
  const productBlurb = resolveProductBlurb(args, files);
  const pool = loadPriorCandidates(home);
  if (pool.length === 0) {
    console.error('No saturation/candidates.json pool — run scenarios generate/saturate first');
    process.exitCode = 1;
    return;
  }

  if (useFixture) {
    const draftId = `scenarios-pool-${stamp()}`;
    const outDir = join(draftsDir(home), draftId);
    ensureDir(outDir);
    writeJsonFile(
      join(outDir, 'scenarios.json'),
      pool.map((c) => ({
        id: c.id,
        utterance: c.utterance,
        expect: { stepId: null },
      }))
    );
    writeJsonFile(join(outDir, 'meta.json'), {
      id: draftId,
      kind: 'soft-label-pool-fixture',
      createdAt: new Date().toISOString(),
      poolSize: pool.length,
      checked: false,
    });
    console.log(`Soft-label pool fixture draft (${pool.length}) → ${outDir}`);
    return;
  }

  const allScenarios: unknown[] = [];
  const labelerKind = resolveLabelerKind();
  const useLabeler =
    labelerKind !== 'llm' || hasFlag(args, '--laya');
  const labeler = useLabeler ? createLabelerFromEnv() : undefined;
  for (let i = 0; i < pool.length; i += chunk) {
    const slice = pool.slice(i, i + chunk);
    console.log(
      `label-pool (${useLabeler ? labeler?.id ?? labelerKind : 'llm'}): chunk ${i / chunk + 1} (${slice.length} of ${pool.length})…`
    );
    const labeled = await labelCandidates({
      labeler,
      provider: useLabeler ? undefined : createProviderFromEnv(),
      candidates: slice,
      flowSteps: files.flow,
      intents: files.intents,
      faq: files.faq,
      productBlurb,
    });
    if (!labeled.ok) {
      console.error(labeled.errors.join('\n'));
      process.exitCode = 1;
      return;
    }
    allScenarios.push(...labeled.scenarios);
  }

  const draftId = `scenarios-pool-${stamp()}`;
  const outDir = join(draftsDir(home), draftId);
  ensureDir(outDir);
  writeJsonFile(join(outDir, 'scenarios.json'), allScenarios);
  const faqDraft = faqDraftFromSoftLabels(allScenarios as never);
  if (faqDraft.length > 0) {
    writeJsonFile(join(outDir, 'faq.json'), faqDraft);
  }
  writeJsonFile(join(outDir, 'meta.json'), {
    id: draftId,
    kind: 'soft-label-pool',
    createdAt: new Date().toISOString(),
    poolSize: pool.length,
    faqEntries: faqDraft.length,
    checked: false,
  });
  console.log(
    `Soft-label pool draft (${allScenarios.length} scenarios, ${faqDraft.length} faq) → ${outDir}`
  );
  console.log(
    'Next: merge scenarios into .notlm/scenarios.json, review faq.json, run intents tune, then pack accept.'
  );
}

/**
 * `notlm-training scenarios ask [dir] --force=N --blurb="..." [--label-pool] [--fixture]`
 * Blurb-led user questions at scale (default force 5000). Does not auto-merge pack/.
 */
export async function cmdScenariosAsk(args: string[]): Promise<void> {
  const force = parseForceCount(args) ?? 5000;
  if (force < 1) {
    console.error('Usage: notlm-training scenarios ask [dir] --force=5000..10000 --blurb="..."');
    process.exitCode = 1;
    return;
  }
  const genArgs = args
    .filter(
      (a) =>
        a !== '--label-pool' &&
        a !== '--label' &&
        !a.startsWith('--force') &&
        !a.startsWith('--hard') &&
        a !== '--mode' &&
        !a.startsWith('--mode=')
    )
    .concat([`--force=${force}`, '--mode=user-ask']);
  console.log(`ask: generating ~${force} user questions (mode=user-ask)…`);
  await cmdScenariosGenerate(genArgs);
  if (exited()) return;

  if (hasFlag(args, '--label-pool') || hasFlag(args, '--label')) {
    console.log('ask: soft-labeling full candidate pool…');
    await cmdScenariosLabelPool(args);
  } else {
    console.log(
      'ask: pool ready — run `scenarios label-pool` then `intents tune` to map to intents/FAQ.'
    );
  }
}

export async function runIntentsTuneIfPossible(dir?: string): Promise<void> {
  const { home } = resolveNotlmHome(dir);
  const files = loadPackFolderJson(home);
  if (!files.scenarios || !files.intents) {
    console.log('tune: skip intents tune (need scenarios.json + pack/intents.json)');
    return;
  }
  if (process.env.NOTLM_SATURATE_FIXTURE === '1') {
    try {
      createProviderFromEnv();
    } catch {
      console.log('tune: skip intents tune (no LLM env in fixture mode)');
      return;
    }
  }

  let failingCases: unknown[] | undefined;
  if (files.manifest && files.flow && files.intents && Array.isArray(files.scenarios)) {
    const check = checkIntents({
      pack: {
        manifest: files.manifest as { id: string },
        flow: files.flow as never,
        controls: (files.controls as never) ?? [],
        intents: files.intents as never,
        binders: files.binders as never,
      },
      scenarios: files.scenarios as never,
    });
    failingCases = check.results.filter((r) => !r.ok);
  }

  const inventory = pathExists(join(home, 'inventory.json'))
    ? readJsonFile(join(home, 'inventory.json'))
    : undefined;
  const provider = createProviderFromEnv();
  const result = await tuneIntents({
    provider,
    currentIntents: files.intents,
    scenarios: files.scenarios,
    failingCases,
    inventory,
    flowSteps: files.flow,
  });
  const draftId = `intents-${stamp()}`;
  const outDir = join(draftsDir(home), draftId);
  ensureDir(outDir);
  if (!result.ok) {
    writeJsonFile(join(outDir, 'errors.json'), {
      errors: result.errors,
      checklist: result.checklist,
    });
    console.error(`intents tune failed; see ${outDir}`);
    process.exitCode = 1;
    return;
  }
  writeJsonFile(join(outDir, 'intents.json'), result.intents);
  writeJsonFile(join(outDir, 'corpus.json'), result.corpus);
  writeJsonFile(join(outDir, 'meta.json'), {
    id: draftId,
    kind: 'intents-tune',
    createdAt: new Date().toISOString(),
    checked: false,
  });
  console.log(`intents tune draft → ${outDir}`);
}

