/**
 * Test-only `.notlm` scaffold — production init lives in notlmCLI.
 */
import { join } from 'node:path';
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
  templateRoot,
  writeJsonFile,
} from './notlmHome.js';

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
