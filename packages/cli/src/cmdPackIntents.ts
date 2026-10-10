import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { authorPackDraft, resolvePackFolder, tuneIntents } from '@notlm-training/author';
import { checkIntents } from '@notlm/core';
import { createProviderFromEnv } from '@notlm-training/llm';
import { checkIntentsInputFromFiles } from './checkIntentsPack.js';
import { hasFlag, positionalDirFirst } from './cliFlags.js';
import {
  PACK_PIECES,
  copyTemplateFile,
  draftsDir,
  ensureDir,
  loadPackFolderJson,
  pathExists,
  readJsonFile,
  resolveActivePackDir,
  resolveNotlmHome,
  unwrapCatalogArray,
  writeJsonFile,
} from './notlmHome.js';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function restorePackFromBackup(backupDir: string, pack: string): void {
  if (!pathExists(backupDir)) return;
  for (const file of readdirSync(backupDir)) {
    copyTemplateFile(join(backupDir, file), join(pack, file));
  }
}

const WRAPPED_CATALOG_KEYS: Record<string, string> = {
  'queries.json': 'queries',
  'faq.json': 'faq',
  'corpus.json': 'corpus',
  'scenarios.json': 'scenarios',
  'lookups.json': 'lookups',
  'glossary.json': 'glossary',
  'mutations.json': 'mutations',
  'tours.json': 'tours',
  'search.json': 'search',
};

function pieceHasContent(file: string, data: unknown): boolean {
  const wrapKey = WRAPPED_CATALOG_KEYS[file];
  if (wrapKey) {
    return unwrapCatalogArray(data, wrapKey).length > 0;
  }
  if (file === 'intents.json') {
    const obj = data as {
      aliases?: Record<string, unknown>;
      meta?: unknown[];
      slots?: Record<string, unknown>;
      confirm?: unknown[];
      metaPatterns?: unknown[];
    } | null;
    if (!obj || typeof obj !== 'object') return false;
    if (obj.aliases) {
      for (const list of Object.values(obj.aliases)) {
        if (
          Array.isArray(list) &&
          list.some((a) => String(a ?? '').trim().length > 0)
        ) {
          return true;
        }
      }
    }
    if (Array.isArray(obj.meta) && obj.meta.length > 0) return true;
    if (obj.slots && Object.keys(obj.slots).length > 0) return true;
    if (Array.isArray(obj.confirm) && obj.confirm.length > 0) return true;
    if (Array.isArray(obj.metaPatterns) && obj.metaPatterns.length > 0) return true;
    return false;
  }
  if (Array.isArray(data)) return data.length > 0;
  if (data != null && typeof data === 'object') {
    return Object.keys(data as object).length > 0;
  }
  return false;
}

/**
 * True when draft JSON is an empty shell that would erase a non-empty pack piece.
 * Returns `{ wipe, reason }` so accept can log accurately.
 */
function wouldWipeNonEmptyPackPiece(
  fromDraft: string,
  dest: string
): { wipe: boolean; reason?: string } {
  const file = fromDraft.replace(/\\/g, '/').split('/').pop() ?? '';
  let draft: unknown;
  try {
    draft = JSON.parse(readFileSync(fromDraft, 'utf8')) as unknown;
  } catch {
    return { wipe: true, reason: 'unreadable draft JSON' };
  }
  if (!pathExists(dest)) {
    // New piece — still refuse unreadable drafts (already handled); allow copy.
    return { wipe: false };
  }
  let pack: unknown;
  try {
    pack = JSON.parse(readFileSync(dest, 'utf8')) as unknown;
  } catch {
    // Corrupt pack + readable draft → allow overwrite (recovery).
    return { wipe: false, reason: 'recovering corrupt pack piece' };
  }
  // intents.json: always merge (even empty drafts) so we never full-replace
  // and drop pack-only aliases / nested fields.
  if (file === 'intents.json') {
    return { wipe: false, reason: 'merge-intents-partial' };
  }
  if (!pieceHasContent(file, draft) && pieceHasContent(file, pack)) {
    return { wipe: true, reason: 'empty draft would wipe non-empty pack' };
  }
  return { wipe: false };
}

/** Merge alias-only / partial intents drafts over pack so nested fields survive. */
function mergeIntentsAccept(pack: unknown, draft: unknown): unknown {
  const p = (pack && typeof pack === 'object' ? pack : {}) as Record<
    string,
    unknown
  >;
  const d = (draft && typeof draft === 'object' ? draft : {}) as Record<
    string,
    unknown
  >;
  const packAliases =
    p.aliases && typeof p.aliases === 'object'
      ? (p.aliases as Record<string, unknown>)
      : {};
  const draftAliases =
    d.aliases && typeof d.aliases === 'object'
      ? (d.aliases as Record<string, unknown>)
      : {};
  const mergedAliases: Record<string, unknown> = { ...packAliases };
  for (const [stepId, list] of Object.entries(draftAliases)) {
    if (!Array.isArray(list)) continue;
    const prev = Array.isArray(mergedAliases[stepId])
      ? (mergedAliases[stepId] as unknown[])
      : [];
    const seen = new Set(prev.map((a) => String(a ?? '').toLowerCase()));
    const next = [...prev];
    for (const a of list) {
      const t = String(a ?? '').trim();
      if (!t || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      next.push(t);
    }
    if (next.length) mergedAliases[stepId] = next;
  }
  const draftMeta =
    Array.isArray(d.meta) && d.meta.length > 0 ? d.meta : undefined;
  const draftSlots =
    d.slots != null &&
    typeof d.slots === 'object' &&
    Object.keys(d.slots as object).length > 0
      ? d.slots
      : undefined;
  const draftConfirm =
    Array.isArray(d.confirm) && d.confirm.length > 0 ? d.confirm : undefined;
  const draftMetaPatterns =
    Array.isArray(d.metaPatterns) && d.metaPatterns.length > 0
      ? d.metaPatterns
      : undefined;
  // Keep pack-only top-level keys; never let a partial draft clobber them via `...d`.
  return {
    ...p,
    aliases: mergedAliases,
    meta: draftMeta ?? p.meta,
    slots: draftSlots ?? p.slots,
    confirm: draftConfirm ?? p.confirm,
    metaPatterns: draftMetaPatterns ?? p.metaPatterns,
  };
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

function wantsFixture(args: string[]): boolean {
  return hasFlag(args, '--fixture') || process.env.NOTLM_SATURATE_FIXTURE === '1';
}

export async function cmdPackAuthor(args: string[] = []): Promise<void> {
  const dir = positionalDirFirst(args);
  const fixture = wantsFixture(args);
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

  let provider: ReturnType<typeof createProviderFromEnv> | null = null;
  if (!fixture) {
    try {
      provider = createProviderFromEnv();
    } catch {
      console.log('pack author: no LLM env — using fixture draft');
    }
  }
  const result = await authorPackDraft({
    provider,
    inventory,
    structuredDraft,
    fixture: fixture || !provider,
  });
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

export async function cmdIntentsTune(args: string[] = []): Promise<void> {
  const dir = positionalDirFirst(args);
  const fixture = wantsFixture(args);
  const { home, projectRoot } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const packDir = resolveActivePackDir(home, projectRoot, resolvePackFolder);
  const files = loadPackFolderJson(home, packDir);
  const scenarios = files.scenarios ?? [];
  const currentIntents = files.intents ?? { aliases: {} };
  const inventory = pathExists(join(home, 'inventory.json'))
    ? readJsonFile(join(home, 'inventory.json'))
    : undefined;

  let failingCases: unknown[] | undefined;
  if (files.manifest && files.flow && files.intents && Array.isArray(scenarios)) {
    const input = checkIntentsInputFromFiles(files, packDir);
    const check = checkIntents({
      pack: input.pack as never,
      scenarios: scenarios as never,
      features: input.features as never,
    });
    failingCases = check.results.filter((r) => !r.ok);
  }

  let provider: ReturnType<typeof createProviderFromEnv> | null = null;
  if (!fixture) {
    try {
      provider = createProviderFromEnv();
    } catch {
      console.log('intents tune: no LLM env — using fixture tune');
    }
  }
  const result = await tuneIntents({
    provider,
    currentIntents,
    scenarios,
    failingCases,
    inventory,
    flowSteps: files.flow,
    fixture: fixture || !provider,
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

  const { home, projectRoot } = resolveNotlmHome(dir);
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

  const pack = resolveActivePackDir(home, projectRoot, resolvePackFolder);
  const hasPackPiece = PACK_PIECES.some((file) => pathExists(join(draftPath, file)));
  const hasScenarios = pathExists(join(draftPath, 'scenarios.json'));
  if (!hasPackPiece && !hasScenarios) {
    console.error(
      `Draft ${draftId} has no pack pieces to accept (expected intents.json / faq.json / …). ` +
        `For misses-cluster drafts, run \`feedback fold --from …/draft.json\` first ` +
        `(cluster also emits a misses-cluster-fold-* draft).`
    );
    process.exitCode = 1;
    return;
  }

  const backupDir = join(draftPath, `pre-accept-backup-${stamp()}`);
  ensureDir(backupDir);
  ensureDir(pack);

  const overwritten: string[] = [];
  const skippedEmpty: string[] = [];
  const acceptedPieces: { file: string; wasNew: boolean }[] = [];
  for (const file of PACK_PIECES) {
    const fromDraft = join(draftPath, file);
    if (!pathExists(fromDraft)) continue;
    const dest = join(pack, file);
    const wipeCheck = wouldWipeNonEmptyPackPiece(fromDraft, dest);
    if (wipeCheck.wipe) {
      skippedEmpty.push(file);
      console.warn(
        `Accept skip ${file}: ${wipeCheck.reason ?? 'refusing wipe'}`
      );
      continue;
    }
    if (wipeCheck.reason === 'recovering corrupt pack piece') {
      console.warn(`Accept ${file}: ${wipeCheck.reason}`);
    }
    const wasNew = !pathExists(dest);
    if (pathExists(dest)) {
      copyTemplateFile(dest, join(backupDir, file));
    }
    if (
      file === 'intents.json' &&
      pathExists(dest) &&
      wipeCheck.reason === 'merge-intents-partial'
    ) {
      try {
        const packIntents = JSON.parse(readFileSync(dest, 'utf8')) as unknown;
        const draftIntents = JSON.parse(readFileSync(fromDraft, 'utf8')) as unknown;
        const merged = mergeIntentsAccept(packIntents, draftIntents);
        writeJsonFile(dest, merged);
        console.warn(
          'Accept intents.json: merged aliases into pack (kept meta/slots/confirm)'
        );
      } catch (err) {
        restorePackFromBackup(backupDir, pack);
        for (const piece of acceptedPieces) {
          if (piece.wasNew) {
            const rollbackDest = join(pack, piece.file);
            if (pathExists(rollbackDest)) unlinkSync(rollbackDest);
          }
        }
        console.error(
          `Accept failed intents.json merge: ${err instanceof Error ? err.message : String(err)}`
        );
        console.warn('Accept rolled back pack pieces from pre-accept backup.');
        process.exitCode = 1;
        return;
      }
    } else {
      copyTemplateFile(fromDraft, dest);
    }
    acceptedPieces.push({ file, wasNew });
    overwritten.push(file);
  }

  // Home-root scenarios gate (intents check) — not a pack/ piece.
  const scenariosFrom = join(draftPath, 'scenarios.json');
  if (pathExists(scenariosFrom)) {
    const scenariosDest = join(home, 'scenarios.json');
    const scenariosWipe = wouldWipeNonEmptyPackPiece(scenariosFrom, scenariosDest);
    if (scenariosWipe.wipe) {
      console.warn(
        `accept: skip scenarios.json — ${scenariosWipe.reason ?? 'refusing wipe'}`
      );
      skippedEmpty.push('scenarios.json');
    } else {
      if (pathExists(scenariosDest)) {
        copyTemplateFile(scenariosDest, join(backupDir, 'scenarios.json'));
      }
      copyTemplateFile(scenariosFrom, scenariosDest);
      overwritten.push('scenarios.json');
    }
  }

  if (!overwritten.length) {
    console.error(
      `Draft ${draftId} produced no writes` +
        (skippedEmpty.length
          ? ` (skipped empty wipe of: ${skippedEmpty.join(', ')})`
          : '')
    );
    process.exitCode = 1;
    return;
  }

  writeJsonFile(join(draftPath, 'ACCEPT_NOTE.json'), {
    acceptedAt: new Date().toISOString(),
    draftId,
    backupDir,
    overwritten,
    skippedEmpty,
    forced: force,
  });

  // Partial accepts (some pieces skipped) must not look fully checked.
  writeJsonFile(metaPath, {
    ...meta,
    checked: skippedEmpty.length === 0,
    acceptedAt: new Date().toISOString(),
    ...(skippedEmpty.length
      ? { acceptIncomplete: true, skippedEmpty }
      : { acceptIncomplete: false }),
  });

  if (skippedEmpty.length) {
    console.warn(
      `Accepted ${draftId} with skipped pieces (${skippedEmpty.join(', ')}) — meta.checked left false until those are resolved.`
    );
  }
  console.log(`Accepted ${draftId} -> ${pack} (backup: ${backupDir})`);
}

