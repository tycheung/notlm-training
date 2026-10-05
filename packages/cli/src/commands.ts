import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  checklistToMarkdown,
  parseJobsYamlLite,
  writeJobsFlowDraft,
} from '@notlm-training/codegen';
import type { ControlInventory, InventoriedControl } from '@notlm-training/mapper';
import { validatePackFolder } from '@notlm/schema';
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
  templateRoot,
  writeJsonFile,
} from './notlmHome.js';

export { cmdInventoryAttach, cmdInventoryCrawl } from './cmdInventory.js';
export { cmdExtractStatic, cmdExtractHost } from './cmdExtract.js';
export { cmdTraceIngest, cmdTraceNew } from './cmdTrace.js';
export {
  cmdIntentsTune,
  cmdPackAccept,
  cmdPackAuthor,
} from './cmdPackIntents.js';

export async function cmdAnnotateChecklist(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith('-'));
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const items: Array<Record<string, unknown>> = [
    {
      id: 'annotate-guide-ids',
      kind: 'annotate',
      message: 'Add data-guide-id on every CTA/field named in controls.json',
      checked: false,
    },
    {
      id: 'annotate-get-context',
      kind: 'annotate',
      message: 'Wire getContext().data keys to match binders.json paths',
      checked: false,
    },
    {
      id: 'annotate-navigate-click',
      kind: 'annotate',
      message: 'navigate() must click/focus [data-guide-id] (UI-actions only)',
      checked: false,
    },
    {
      id: 'annotate-notify-complete',
      kind: 'annotate',
      message: 'Call notifyStepCompleted(stepId) after host save that finishes a step',
      checked: false,
    },
    {
      id: 'annotate-field-prefill',
      kind: 'annotate',
      message: 'Annotate fillable inputs with guide ids matching control prefill keys',
      checked: false,
    },
    {
      id: 'annotate-intents-check',
      kind: 'annotate',
      message: 'Run notlmCLI intents check until green before accepting drafts',
      checked: false,
    },
  ];

  const path = join(home, 'checklist.json');
  const current = pathExists(path)
    ? readJsonFile<{ items?: Array<{ id?: string }> }>(path)
    : { items: [] };
  const list = Array.isArray(current.items) ? [...current.items] : [];
  const have = new Set(list.map((i) => i.id).filter(Boolean));
  let added = 0;
  for (const item of items) {
    if (have.has(item.id as string)) continue;
    list.push(item);
    added += 1;
  }
  writeJsonFile(path, { items: list });
  console.log(`Annotation checklist: ${path} (+${added} items, ${list.length} total)`);
}

export async function cmdInit(dir?: string): Promise<void> {
  const { home } = resolveNotlmHome(dir);
  if (pathExists(home)) {
    console.error(`Already exists: ${home}`);
    process.exitCode = 1;
    return;
  }

  const template = templateRoot();
  if (!pathExists(template)) {
    console.error(`Template not found: ${template}`);
    process.exitCode = 1;
    return;
  }

  ensureDir(home);
  ensureDir(packDir(home));
  ensureDir(draftsDir(home));
  ensureDir(join(home, 'traces'));

  copyTemplateFile(join(template, 'config.json'), join(home, 'config.json'));
  copyTemplateFile(join(template, 'scenarios.json'), join(home, 'scenarios.json'));

  for (const file of PACK_PIECES) {
    const src = join(template, file);
    const dest = join(packDir(home), file);
    if (!pathExists(src)) continue;
    if (file === 'binders.json') {
      // Schema expects an array; template historically used {}.
      const raw = readJsonFile(src);
      writeJsonFile(dest, Array.isArray(raw) ? raw : []);
    } else {
      copyTemplateFile(src, dest);
    }
  }

  writeJsonFile(join(home, 'inventory.json'), {
    capturedAt: new Date().toISOString(),
    baseUrl: '',
    controls: [],
  } satisfies ControlInventory);

  writeJsonFile(join(home, 'structured-draft.json'), {
    generatedAt: new Date().toISOString(),
    steps: [],
    controls: [],
  });

  writeJsonFile(join(home, 'checklist.json'), { items: [] });

  console.log(`Initialized ${home}`);
}

export async function cmdValidate(dir?: string): Promise<void> {
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }
  const files = loadPackFolderJson(home);
  const result = validatePackFolder(files);
  if (!result.ok) {
    for (const e of result.errors) console.error(e);
    process.exitCode = 1;
    return;
  }
  console.log(`OK ${home}`);
}

export async function cmdJobsImport(args: string[]): Promise<void> {
  const jobsFile = args.find((a) => !a.startsWith('-'));
  const dir = args.filter((a) => a !== jobsFile && !a.startsWith('-')).at(-1);

  if (!jobsFile) {
    console.error('Usage: notlm-training jobs import <jobs.yaml|json> [dir]');
    process.exitCode = 1;
    return;
  }

  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const abs = resolve(jobsFile);
  if (!pathExists(abs)) {
    console.error(`Jobs file not found: ${abs}`);
    process.exitCode = 1;
    return;
  }

  const text = readFileSync(abs, 'utf8');
  const doc = parseJobsYamlLite(text);
  const draftId = `jobs-${stamp()}`;
  const outDir = writeJobsFlowDraft(home, doc, draftId);
  console.log(`Wrote jobs flow draft ${outDir}`);
}

/**
 * `notlm-training checklist md [dir]` — print or `--write` CHECKLIST.md
 */
export async function cmdChecklistMd(args: string[]): Promise<void> {
  const writeIdx = args.indexOf('--write');
  const writePath =
    writeIdx >= 0
      ? (args[writeIdx + 1] && !args[writeIdx + 1]!.startsWith('-')
          ? args[writeIdx + 1]
          : 'CHECKLIST.md')
      : undefined;
  const flagNames = new Set(['--write']);
  const dir = positionalDir(
    args.filter((a, i) => {
      if (writeIdx >= 0 && i === writeIdx + 1 && writePath && a === writePath) {
        return false;
      }
      return true;
    }),
    flagNames
  );

  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const checklistPath = join(home, 'checklist.json');
  const checklist = pathExists(checklistPath)
    ? readJsonFile(checklistPath)
    : { items: [] };
  const md = checklistToMarkdown(checklist as never);

  if (writePath) {
    const out = resolve(home, writePath);
    ensureDir(dirname(out));
    writeFileSync(out, md.endsWith('\n') ? md : `${md}\n`, 'utf8');
    console.log(`Wrote ${out}`);
  } else {
    process.stdout.write(md.endsWith('\n') ? md : `${md}\n`);
  }
}

export async function cmdDagGenerate(dir?: string): Promise<void> {
  const { home } = resolveNotlmHome(dir);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
    process.exitCode = 1;
    return;
  }

  const invPath = join(home, 'inventory.json');
  const inventory = pathExists(invPath)
    ? readJsonFile<ControlInventory>(invPath)
    : { capturedAt: new Date().toISOString(), baseUrl: '', controls: [] };

  const steps = inventory.controls.map((c: InventoriedControl) => {
    const id = (c.existingGuideId ?? c.proposedGuideId).replace(/^guide-/, '');
    return {
      id,
      title: c.name || id,
      kind: 'soft',
      requires: [] as string[],
      confidence: 'low' as const,
      sourceGuideId: c.existingGuideId ?? c.proposedGuideId,
    };
  });

  const draftControls = inventory.controls.map((c: InventoriedControl) => ({
    id: c.existingGuideId ?? c.proposedGuideId,
    role: c.role,
    name: c.name,
    selectorHint: c.selectorHint,
    path: c.url || undefined,
  }));

  const structured = {
    generatedAt: new Date().toISOString(),
    baseUrl: inventory.baseUrl,
    steps,
    controls: draftControls,
  };

  const checklistItems: Array<Record<string, unknown>> = [];
  for (const c of inventory.controls) {
    if (!c.existingGuideId) {
      checklistItems.push({
        id: `annotate-${c.proposedGuideId}`,
        kind: 'missing-guide-id',
        message: `Add data-guide-id="${c.proposedGuideId}" for ${c.role} "${c.name}"`,
        proposedGuideId: c.proposedGuideId,
        checked: false,
      });
    }
  }
  checklistItems.push({
    id: 'binders-review',
    kind: 'binders',
    message: 'Review structured-draft steps and add binders.json entries',
    checked: false,
  });

  writeJsonFile(join(home, 'structured-draft.json'), structured);
  writeJsonFile(join(home, 'checklist.json'), { items: checklistItems });
  console.log(
    `Wrote structured-draft.json (${steps.length} steps) and checklist.json (${checklistItems.length} items)`
  );
}
function positionalDir(args: string[], flagNames: Set<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (flagNames.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

