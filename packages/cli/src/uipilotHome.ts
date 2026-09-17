import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UIPILOT_DIRNAME = '.uipilot';

export type UipilotHome = {
  /** Directory containing `.uipilot` (or that is the home itself). */
  projectRoot: string;
  /** Absolute path to `.uipilot`. */
  home: string;
};

export function resolveUipilotHome(dir?: string): UipilotHome {
  const projectRoot = resolve(dir ?? process.cwd());
  if (basenameIsUipilot(projectRoot)) {
    return { projectRoot: dirname(projectRoot), home: projectRoot };
  }
  const nested = join(projectRoot, UIPILOT_DIRNAME);
  return { projectRoot, home: nested };
}

function basenameIsUipilot(p: string): boolean {
  const base = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return base === UIPILOT_DIRNAME;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readJsonFile<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJsonFile(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function packDir(home: string): string {
  return join(home, 'pack');
}

export function draftsDir(home: string): string {
  return join(home, 'drafts');
}

/** Absolute path to operating uipilot `packs/_template` (sibling checkout). */
export function templateRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ or src/ → packages/cli → uipilot-training → repo root → uipilot/packs/_template
  return resolve(here, '../../../../uipilot/packs/_template');
}

export const PACK_PIECES = [
  'manifest.json',
  'flow.json',
  'controls.json',
  'intents.json',
  'binders.json',
  'corpus.json',
  'glossary.json',
  'faq.json',
  'lookups.json',
  'replies.json',
] as const;

export function loadPackFolderJson(home: string): Record<string, unknown> {
  const pack = packDir(home);
  const out: Record<string, unknown> = {};
  for (const file of PACK_PIECES) {
    const p = join(pack, file);
    if (!existsSync(p)) continue;
    const key = file.replace(/\.json$/, '');
    out[key] = readJsonFile(p);
  }
  const configPath = join(home, 'config.json');
  if (existsSync(configPath)) out.config = readJsonFile(configPath);
  const scenariosPath = join(home, 'scenarios.json');
  if (existsSync(scenariosPath)) out.scenarios = readJsonFile(scenariosPath);
  return out;
}

export function copyTemplateFile(src: string, dest: string): void {
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
}

export { join, resolve, existsSync };
