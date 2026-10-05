import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveNotlmHome as resolveNotlmHomeCore } from '@notlm/core/loadFolder';

export type NotlmHome = {
  /** Directory containing `.notlm` (or that is the home itself). */
  projectRoot: string;
  /** Absolute path to `.notlm`. */
  home: string;
};

export function resolveNotlmHome(dir?: string): NotlmHome {
  return resolveNotlmHomeCore(dir);
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
