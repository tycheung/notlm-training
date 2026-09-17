import { resolve } from 'node:path';
import {
  mergeGuideIdScan,
  runStructuredExtract,
  type ControlInventory,
} from '@uipilot/mapper';
import {
  join,
  pathExists,
  readJsonFile,
  resolveUipilotHome,
  writeJsonFile,
} from './uipilotHome.js';

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

export async function cmdExtractStatic(args: string[]): Promise<void> {
  const flagNames = new Set(['--src']);
  const srcIdx = args.indexOf('--src');
  let srcPath = srcIdx >= 0 ? args[srcIdx + 1] : undefined;
  const positionals = args.filter((a, i) => {
    if (flagNames.has(a)) return false;
    if (i > 0 && flagNames.has(args[i - 1]!)) return false;
    if (a.startsWith('-')) return false;
    return true;
  });
  // Prefer explicit --src; else bare paths: `<srcDir> [packDir]` (npm often strips --src).
  if (!srcPath) {
    if (positionals.length >= 2) {
      srcPath = positionals[0];
    } else if (positionals.length === 1) {
      // Single path: treat as source; pack dir defaults to cwd
      srcPath = positionals[0];
    }
  }
  const dir =
    srcIdx >= 0
      ? positionalDir(args, flagNames)
      : positionals.length >= 2
        ? positionals[positionals.length - 1]
        : undefined;

  if (!srcPath) {
    console.error('Usage: uipilot-training extract static [dir] --src <path>');
    console.error('Or:    uipilot-training extract static <srcDir> [packDir]');
    console.error('Tip: npm may swallow --src; pass a bare source path instead.');
    process.exitCode = 1;
    return;
  }

  const { home } = resolveUipilotHome(dir && dir !== srcPath ? dir : undefined);
  if (!pathExists(home)) {
    console.error(`Missing UiPilot home: ${home} (run uipilotCLI init)`);
    process.exitCode = 1;
    return;
  }

  const sourceDir = resolve(srcPath);
  if (!pathExists(sourceDir)) {
    console.error(`Source path not found: ${sourceDir}`);
    process.exitCode = 1;
    return;
  }

  const extract = runStructuredExtract(sourceDir);
  writeJsonFile(join(home, 'structured-draft.json'), extract);

  const invPath = join(home, 'inventory.json');
  const existing = pathExists(invPath)
    ? readJsonFile<ControlInventory>(invPath)
    : null;
  const merged = mergeGuideIdScan(existing, sourceDir, {
    baseUrl: existing?.baseUrl ?? '',
  });
  writeJsonFile(invPath, merged);

  const checklistItems: Array<Record<string, unknown>> = [
    {
      id: 'extract-static-review',
      kind: 'extract',
      message: `Review structured extract from ${sourceDir} (${extract.screens.length} screens, ${extract.writeCandidates.length} write candidates, ${extract.guideIds.length} guide ids)`,
      checked: false,
    },
    {
      id: 'binders-review',
      kind: 'binders',
      message: 'Review structured-draft steps and add binders.json entries',
      checked: false,
    },
  ];
  for (const form of extract.writeCandidates) {
    checklistItems.push({
      id: `write-${form.kind}-${form.file}`.replace(/[^a-zA-Z0-9._-]+/g, '-'),
      kind: 'write-candidate',
      message: `Map ${form.kind} in ${form.file} (${form.nameHint.slice(0, 40)})`,
      checked: false,
    });
  }

  writeJsonFile(join(home, 'checklist.json'), { items: checklistItems });
  console.log(
    `Wrote structured-draft.json + inventory (${merged.controls.length} controls) + checklist (${checklistItems.length} items)`
  );
}
