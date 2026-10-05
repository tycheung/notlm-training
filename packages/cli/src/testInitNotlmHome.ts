/**
 * Test-only `.notlm` scaffold — production init lives in notlmCLI.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ControlInventory } from '@notlm-training/mapper';
import {
  PACK_PIECES,
  copyTemplateFile,
  draftsDir,
  ensureDir,
  packDir,
  pathExists,
  readJsonFile,
  resolveNotlmHome,
  writeJsonFile,
} from './notlmHome.js';

/** Absolute path to operating notlm `packs/_template` (sibling checkout). */
function templateRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ or src/ → packages/cli → notlm-training → repo root → notlm/packs/_template
  return resolve(here, '../../../../notlm/packs/_template');
}

export async function initNotlmHomeForTests(dir?: string): Promise<void> {
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
}
