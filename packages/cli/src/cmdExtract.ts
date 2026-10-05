import { join, resolve } from 'node:path';
import {
  mergeGuideIdScan,
  runStructuredExtract,
  type ControlInventory,
} from '@notlm-training/mapper';
import {
  pathExists,
  readJsonFile,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';
import { positionalDir } from './cliFlags.js';

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
      ? positionalDir(args, new Set(['--src']))
      : positionals.length >= 2
        ? positionals[positionals.length - 1]
        : undefined;

  if (!srcPath) {
    console.error('Usage: notlm-training extract static [dir] --src <path>');
    console.error('Or:    notlm-training extract static <srcDir> [packDir]');
    console.error('Tip: npm may swallow --src; pass a bare source path instead.');
    process.exitCode = 1;
    return;
  }

  const { home } = resolveNotlmHome(dir && dir !== srcPath ? dir : undefined);
  if (!pathExists(home)) {
    console.error(`Missing NotLM home: ${home} (run notlmCLI init)`);
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

const PACK_REQUIRED = ['manifest', 'flow', 'controls', 'intents', 'binders'] as const;

/**
 * Host-oriented workshop: extract from a host SPA into that host's `.notlm/`.
 * Product packs deploy from the host tree — not from notlm demo packs.
 */
export async function cmdExtractHost(args: string[]): Promise<void> {
  const hostRoot = args.find((a) => !a.startsWith('-'));
  if (!hostRoot) {
    console.error('Usage: notlm-training extract host <hostAppRoot>');
    console.error('Example: notlm-training extract host ../my-app');
    process.exitCode = 1;
    return;
  }
  const root = resolve(hostRoot);
  if (!pathExists(root)) {
    console.error(`Host root not found: ${root}`);
    process.exitCode = 1;
    return;
  }
  const { home } = resolveNotlmHome(root);
  if (!pathExists(home)) {
    console.error(
      `Missing NotLM home: ${home}\nRun: notlmCLI init ${root}`
    );
    process.exitCode = 1;
    return;
  }

  const srcCandidates = ['src', 'app', 'apps/web/src'].map((r) => join(root, r));
  const srcPath = srcCandidates.find((p) => pathExists(p)) ?? join(root, 'src');
  if (!pathExists(srcPath)) {
    console.error(
      `No src tree under ${root} (tried src/, app/). Pass extract static with --src instead.`
    );
    process.exitCode = 1;
    return;
  }

  await cmdExtractStatic([srcPath, root]);

  const packDir = join(home, 'pack');
  const missing = PACK_REQUIRED.filter(
    (k) => !pathExists(join(packDir, `${k}.json`))
  );
  if (missing.length) {
    console.warn(
      `Pack pieces still missing under ${packDir}: ${missing.join(', ')} — author/map next.`
    );
  } else {
    console.log(`Deploy pack ready at ${packDir}`);
    console.log(
      'Next: review drafts → pack accept → host green/CloudFront deploy. Laya weights stay on the backend promote path.'
    );
  }
}

