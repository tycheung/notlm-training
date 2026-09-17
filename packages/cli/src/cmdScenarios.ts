import {
  faqDraftFromSoftLabels,
  llmBatchGenerator,
  mineIntentFailures,
  runHardAugment,
  runSaturationLoop,
  scoreBatchAgainstPrior,
  softLabelCandidates,
  splitContextBatchGenerator,
  buildContextTreePlan,
  type ScenarioCandidate,
} from '@uipilot/author';
import { checkIntents } from '@uipilot/core';
import { createProviderFromEnv } from '@uipilot/llm';
import {
  draftsDir,
  ensureDir,
  join,
  loadPackFolderJson,
  pathExists,
  readJsonFile,
  resolveUipilotHome,
  writeJsonFile,
} from './uipilotHome.js';
import {
  FIXTURE_SEED,
  USER_ASK_FIXTURE_SEED,
  appendChecklist,
  asIntentPack,
  bareNumbers,
  fixtureBatchGenerator,
  hasFlag,
  loadPriorCandidates,
  parseFlag,
  parseForceCount,
  positionalDir,
  resolveGenerateMode,
  resolveProductBlurb,
  saturationDir,
  stamp,
  writeSaturationArtifacts,
} from './scenarioCliShared.js';

export async function cmdScenariosGenerate(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home } = resolveUipilotHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing UiPilot home: ${home} (run uipilotCLI init)`);
    process.exitCode = 1;
    return;
  }

  const forceCount = parseForceCount(args);
  const bare = bareNumbers(args);
  const batchSize = Number(
    parseFlag(args, '--batch') ?? bare[0] ?? (forceCount ? String(forceCount) : '100')
  );
  const useFixture = hasFlag(args, '--fixture') || process.env.UIPILOT_SATURATE_FIXTURE === '1';
  const mode = resolveGenerateMode(args);
  const files = loadPackFolderJson(home);
  const productBlurb = resolveProductBlurb(args, files);
  const pack = asIntentPack(files);
  if (!pack) {
    console.error('pack/ requires flow.json and intents.json');
    process.exitCode = 1;
    return;
  }

  const prior = loadPriorCandidates(home);
  const inventory = pathExists(join(home, 'inventory.json'))
    ? readJsonFile(join(home, 'inventory.json'))
    : undefined;
  const structuredDraft = pathExists(join(home, 'structured-draft.json'))
    ? readJsonFile(join(home, 'structured-draft.json'))
    : undefined;

  const fixtureSeed = mode === 'user-ask' ? USER_ASK_FIXTURE_SEED : FIXTURE_SEED;
  const wantSplit = mode === 'flow' && !hasFlag(args, '--no-split-context');
  const treePlan = buildContextTreePlan(pack);
  let generateBatch;
  let splitNote = 'off';
  if (useFixture) {
    generateBatch = fixtureBatchGenerator(fixtureSeed);
    splitNote = 'fixture';
  } else if (wantSplit) {
    const split = splitContextBatchGenerator({
      pack,
      provider: createProviderFromEnv(),
      inventory,
      structuredDraft,
      productBlurb,
      enabled: true,
    });
    generateBatch = split.generateBatch;
    splitNote = split.plan.muddy
      ? `auto(${split.plan.modes.length} modes, ${split.plan.sharedPhraseCount} shared phrases)`
      : 'auto(clean)';
  } else {
    generateBatch = llmBatchGenerator({
      provider: createProviderFromEnv(),
      flowSteps: files.flow,
      intents: files.intents,
      inventory,
      structuredDraft,
      productBlurb,
      mode,
    });
  }
  ensureDir(saturationDir(home));
  writeJsonFile(join(saturationDir(home), 'context-tree.json'), {
    updatedAt: new Date().toISOString(),
    ...treePlan,
    splitNote,
  });

  if (forceCount !== undefined) {
    const result = await runHardAugment({
      pack,
      prior,
      count: forceCount,
      chunkSize: Math.min(100, forceCount),
      generateBatch,
    });
    writeSaturationArtifacts(home, result.candidates, {
      ...result.report,
      mode,
      productBlurb: productBlurb ?? null,
    });
    console.log(
      `Hard augment --force=${forceCount} mode=${mode} split=${splitNote}: pool=${result.candidates.length} (stop=${result.stopReason}) → ${saturationDir(home)}`
    );
    return;
  }

  const priorUtterances = prior.map((c) => c.utterance);
  const priorSignatures = prior.map((c) => c.parseSignature ?? 'null');

  let raw: Array<{ id?: string; utterance: string }>;
  try {
    raw = await generateBatch({
      batchIndex: 0,
      batchSize: Math.max(1, batchSize),
      priorUtterances,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exitCode = 1;
    return;
  }
  if (raw.length === 0) {
    console.error('No candidates generated');
    process.exitCode = 1;
    return;
  }

  const batchId = `batch-${stamp()}`;
  const { scored, summary } = scoreBatchAgainstPrior({
    batchId,
    utterances: raw.map((u, i) => ({ id: u.id ?? `${batchId}-${i}`, utterance: u.utterance })),
    priorUtterances,
    priorSignatures,
    pack,
  });

  const candidates = [...prior, ...scored];
  const report = {
    generatedAt: new Date().toISOString(),
    mode: useFixture ? `fixture:${mode}` : mode,
    productBlurb: productBlurb ?? null,
    splitNote,
    batches: [summary],
    plateau: false,
    priorPoolSize: prior.length,
    consecutiveNoLift: 0,
  };
  writeSaturationArtifacts(home, candidates, report, batchId, scored);
  console.log(
    `Generated ${scored.length} candidates mode=${mode} split=${splitNote} ` +
      `(lift=${summary.lift.toFixed(3)}, incremental=${summary.incrementalNovelty.toFixed(3)}) → ${saturationDir(home)}`
  );
}

/**
 * `uipilot-training scenarios saturate [dir] [--batch=100] [--max-batches=N] [--fixture] [--force=N]`
 * Default batch=100 for no-lift rule (5×100). `--force=N` ignores novelty.
 */
async function softLabelAndDraft(
  home: string,
  files: Record<string, unknown>,
  candidates: ScenarioCandidate[],
  productBlurb?: string
): Promise<void> {
  const provider = createProviderFromEnv();
  const labeled = await softLabelCandidates({
    provider,
    candidates,
    flowSteps: files.flow,
    intents: files.intents,
    faq: files.faq,
    productBlurb,
  });
  const draftId = `scenarios-${stamp()}`;
  const outDir = join(draftsDir(home), draftId);
  ensureDir(outDir);
  if (!labeled.ok) {
    writeJsonFile(join(outDir, 'errors.json'), {
      errors: labeled.errors,
      checklist: labeled.checklist,
    });
    console.error(`Soft-label failed; see ${outDir}`);
    process.exitCode = 1;
    return;
  }
  writeJsonFile(join(outDir, 'scenarios.json'), labeled.scenarios);
  const faqDraft = faqDraftFromSoftLabels(labeled.scenarios);
  if (faqDraft.length > 0) {
    writeJsonFile(join(outDir, 'faq.json'), faqDraft);
  }
  writeJsonFile(join(outDir, 'meta.json'), {
    id: draftId,
    kind: 'soft-label',
    createdAt: new Date().toISOString(),
    faqEntries: faqDraft.length,
    checked: false,
  });
  console.log(`Soft-label draft → ${outDir}`);
}

/**
 * After saturate, optionally run intents tune when scenarios exist.
 * Used by `uipilot-training tune` façade.
 */

export async function cmdScenariosSaturate(args: string[]): Promise<void> {
  const dir = positionalDir(args);
  const { home } = resolveUipilotHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing UiPilot home: ${home} (run uipilotCLI init)`);
    process.exitCode = 1;
    return;
  }

  const forceCount = parseForceCount(args);
  const bare = bareNumbers(args);
  // When --force is set, bare[0] is the force count if flags were stripped — don't use as batch
  const batchSize = Number(
    parseFlag(args, '--batch') ?? (forceCount !== undefined ? '100' : bare[0] ?? '100')
  );
  const maxBatches = Number(
    parseFlag(args, '--max-batches') ?? (forceCount !== undefined ? '1' : bare[1] ?? '50')
  );
  const useFixture = hasFlag(args, '--fixture') || process.env.UIPILOT_SATURATE_FIXTURE === '1';
  const mode = resolveGenerateMode(args);
  const files = loadPackFolderJson(home);
  const productBlurb = resolveProductBlurb(args, files);
  const pack = asIntentPack(files);
  if (!pack) {
    console.error('pack/ requires flow.json and intents.json');
    process.exitCode = 1;
    return;
  }

  const prior = loadPriorCandidates(home);
  const inventory = pathExists(join(home, 'inventory.json'))
    ? readJsonFile(join(home, 'inventory.json'))
    : undefined;
  const structuredDraft = pathExists(join(home, 'structured-draft.json'))
    ? readJsonFile(join(home, 'structured-draft.json'))
    : undefined;

  const fixtureSeed = mode === 'user-ask' ? USER_ASK_FIXTURE_SEED : FIXTURE_SEED;
  const wantSplit = mode === 'flow' && !hasFlag(args, '--no-split-context');
  const treePlan = buildContextTreePlan(pack);
  let generateBatch;
  let splitNote = 'off';
  if (useFixture) {
    generateBatch = fixtureBatchGenerator(fixtureSeed);
    splitNote = 'fixture';
  } else if (wantSplit) {
    const split = splitContextBatchGenerator({
      pack,
      provider: createProviderFromEnv(),
      inventory,
      structuredDraft,
      productBlurb,
      enabled: true,
    });
    generateBatch = split.generateBatch;
    splitNote = split.plan.muddy
      ? `auto(${split.plan.modes.length} modes, ${split.plan.sharedPhraseCount} shared phrases)`
      : 'auto(clean)';
  } else {
    generateBatch = llmBatchGenerator({
      provider: createProviderFromEnv(),
      flowSteps: files.flow,
      intents: files.intents,
      inventory,
      structuredDraft,
      productBlurb,
      mode,
    });
  }
  ensureDir(saturationDir(home));
  writeJsonFile(join(saturationDir(home), 'context-tree.json'), {
    updatedAt: new Date().toISOString(),
    ...treePlan,
    splitNote,
  });

  const result =
    forceCount !== undefined
      ? await runHardAugment({
          pack,
          prior,
          count: forceCount,
          chunkSize: Math.min(batchSize, forceCount),
          generateBatch,
        })
      : await runSaturationLoop({
          pack,
          prior,
          batchSize,
          maxBatches,
          generateBatch,
        });

  writeSaturationArtifacts(home, result.candidates, {
    ...result.report,
    mode: useFixture ? `fixture:${mode}` : mode,
    productBlurb: productBlurb ?? null,
  });
  console.log(
    `Saturate: ${result.batchesRun} batches, pool=${result.candidates.length}, mode=${mode}, ` +
      `split=${splitNote}, stop=${result.stopReason}, plateau=${result.plateau}, noLift=${result.noLiftStop}`
  );
  for (const b of result.report.batches) {
    console.log(
      `  ${b.batchId}: lift=${b.lift.toFixed(3)} lex=${b.meanLexicalNovelty.toFixed(3)} ` +
        `incremental=${b.incrementalNovelty.toFixed(3)}`
    );
  }

  if (Array.isArray(files.scenarios) && files.manifest && files.flow && files.intents) {
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
    const failures = check.results.filter((r) => !r.ok);
    if (failures.length > 0) {
      const mined = mineIntentFailures(failures);
      appendChecklist(home, mined.checklist);
      const draftId = `sat-failures-${stamp()}`;
      const outDir = join(draftsDir(home), draftId);
      ensureDir(outDir);
      writeJsonFile(join(outDir, 'failure-hints.json'), mined.draftHints);
      writeJsonFile(join(outDir, 'meta.json'), {
        id: draftId,
        kind: 'saturation-failures',
        createdAt: new Date().toISOString(),
        checked: false,
      });
      console.log(`Mined ${failures.length} scenario failures → ${outDir}`);
    }
  }

  if (hasFlag(args, '--label') && !useFixture) {
    await softLabelAndDraft(home, files, result.candidates.slice(-batchSize), productBlurb);
  } else if (hasFlag(args, '--label') && useFixture) {
    const slice = result.candidates.slice(-batchSize);
    const draftId = `scenarios-${stamp()}`;
    const outDir = join(draftsDir(home), draftId);
    ensureDir(outDir);
    writeJsonFile(
      join(outDir, 'scenarios.json'),
      slice.map((c) => ({
        id: c.id,
        utterance: c.utterance,
        expect: { stepId: null },
      }))
    );
    writeJsonFile(join(outDir, 'meta.json'), {
      id: draftId,
      kind: 'soft-label-fixture',
      createdAt: new Date().toISOString(),
      checked: false,
    });
    console.log(`Soft-label fixture draft → ${outDir}`);
  }
}

/**
 * `uipilot-training scenarios label-pool [dir] [--chunk=50] [--fixture]`
 * Soft-label the entire saturation/candidates.json pool in chunks → drafts/.
 */

