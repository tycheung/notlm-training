import { join } from 'node:path';
import { authorPackDraft, tuneIntents } from '@notlm-training/author';
import { checkIntents } from '@notlm/core';
import { createProviderFromEnv } from '@notlm-training/llm';
import {
  PACK_PIECES,
  copyTemplateFile,
  draftsDir,
  ensureDir,
  loadPackFolderJson,
  packDir,
  pathExists,
  readJsonFile,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function newDraftId(prefix: string): string {
  return `${prefix}-${stamp()}`;
}

function appendChecklist(home: string, items: Array<Record<string, unknown>>): void {
  const path = join(home, 'checklist.json');
  const current = pathExists(path)
    ? readJsonFile<{ items?: unknown[] }>(path)
    : { items: [] };
  const list = Array.isArray(current.items) ? [...current.items] : [];
  list.push(...items);
  writeJsonFile(path, { items: list });
}

export async function cmdPackAuthor(dir?: string): Promise<void> {
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const inventory = pathExists(join(home, 'inventory.json'))
    ? readJsonFile(join(home, 'inventory.json'))
    : { controls: [] };
  const structuredDraft = pathExists(join(home, 'structured-draft.json'))
    ? readJsonFile(join(home, 'structured-draft.json'))
    : { steps: [] };

  const provider = createProviderFromEnv();
  const result = await authorPackDraft({ provider, inventory, structuredDraft });
  const draftId = newDraftId('pack');
  const outDir = join(draftsDir(home), draftId);
  ensureDir(outDir);

  if (!result.ok) {
    writeJsonFile(join(outDir, 'errors.json'), {
      errors: result.errors,
      checklist: result.checklist,
    });
    appendChecklist(home, result.checklist.map((m) => ({
      id: `author-error-${Date.now()}`,
      kind: 'author-error',
      message: m,
      checked: false,
    })));
    console.error(`Author failed; see ${outDir}/errors.json`);
    process.exitCode = 1;
    return;
  }

  const pieces = result.draft;
  for (const key of ['manifest', 'flow', 'controls', 'intents', 'binders', 'corpus'] as const) {
    if (pieces[key] !== undefined) {
      writeJsonFile(join(outDir, `${key}.json`), pieces[key]);
    }
  }
  writeJsonFile(join(outDir, 'meta.json'), {
    id: draftId,
    kind: 'pack-author',
    createdAt: new Date().toISOString(),
    checked: false,
  });
  console.log(`Draft written to ${outDir}`);
}

export async function cmdIntentsTune(dir?: string): Promise<void> {
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const files = loadPackFolderJson(home);
  const scenarios = files.scenarios ?? [];
  const currentIntents = files.intents ?? { aliases: {} };
  const inventory = pathExists(join(home, 'inventory.json'))
    ? readJsonFile(join(home, 'inventory.json'))
    : undefined;

  let failingCases: unknown[] | undefined;
  if (files.manifest && files.flow && files.intents && Array.isArray(scenarios)) {
    const check = checkIntents({
      pack: {
        manifest: files.manifest as { id: string },
        flow: files.flow as never,
        controls: (files.controls as never) ?? [],
        intents: files.intents as never,
        binders: files.binders as never,
      },
      scenarios: scenarios as never,
    });
    failingCases = check.results.filter((r) => !r.ok);
  }

  const provider = createProviderFromEnv();
  const result = await tuneIntents({
    provider,
    currentIntents,
    scenarios,
    failingCases,
    inventory,
    flowSteps: files.flow,
  });

  const draftId = newDraftId('intents');
  const outDir = join(draftsDir(home), draftId);
  ensureDir(outDir);

  if (!result.ok) {
    writeJsonFile(join(outDir, 'errors.json'), {
      errors: result.errors,
      checklist: result.checklist,
    });
    console.error(`Tune failed; see ${outDir}/errors.json`);
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
  console.log(`Draft written to ${outDir}`);
}

/**
 * Merge `drafts/<draftId>/` into `pack/`.
 * Refuses unchecked drafts (meta.checked !== true) unless NOTLM_FORCE_ACCEPT=1.
 * Always writes a pre-accept backup under the draft folder.
 */
export async function cmdPackAccept(draftId: string, dir?: string): Promise<void> {
  if (!draftId) {
    console.error('Usage: notlm-training pack accept <draftId>');
    process.exitCode = 1;
    return;
  }

  const { home } = resolveNotlmHome(dir);
  const draftPath = join(draftsDir(home), draftId);
  if (!pathExists(draftPath)) {
    console.error(`Draft not found: ${draftPath}`);
    process.exitCode = 1;
    return;
  }

  const metaPath = join(draftPath, 'meta.json');
  const meta = pathExists(metaPath)
    ? readJsonFile<{ checked?: boolean; kind?: string }>(metaPath)
    : { checked: false };

  const force = process.env.NOTLM_FORCE_ACCEPT === '1';
  if (!meta.checked && !force) {
    console.error(
      `Draft ${draftId} is unchecked (meta.checked !== true). ` +
        `Review the draft, set "checked": true in meta.json, then re-run — ` +
        `or set NOTLM_FORCE_ACCEPT=1 to override.`
    );
    process.exitCode = 1;
    return;
  }

  const backupDir = join(draftPath, `pre-accept-backup-${stamp()}`);
  ensureDir(backupDir);
  const pack = packDir(home);
  ensureDir(pack);

  const overwritten: string[] = [];
  for (const file of PACK_PIECES) {
    const fromDraft = join(draftPath, file);
    if (!pathExists(fromDraft)) continue;
    const dest = join(pack, file);
    if (pathExists(dest)) {
      copyTemplateFile(dest, join(backupDir, file));
    }
    copyTemplateFile(fromDraft, dest);
    overwritten.push(file);
  }

  // Home-root scenarios gate (intents check) — not a pack/ piece.
  const scenariosFrom = join(draftPath, 'scenarios.json');
  if (pathExists(scenariosFrom)) {
    const scenariosDest = join(home, 'scenarios.json');
    if (pathExists(scenariosDest)) {
      copyTemplateFile(scenariosDest, join(backupDir, 'scenarios.json'));
    }
    copyTemplateFile(scenariosFrom, scenariosDest);
    overwritten.push('scenarios.json');
  }

  writeJsonFile(join(draftPath, 'ACCEPT_NOTE.json'), {
    acceptedAt: new Date().toISOString(),
    draftId,
    backupDir,
    overwritten,
    forced: force,
  });

  writeJsonFile(metaPath, { ...meta, checked: true, acceptedAt: new Date().toISOString() });

  console.log(`Accepted ${draftId} -> ${pack} (backup: ${backupDir})`);
}

