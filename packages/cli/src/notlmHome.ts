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

/** Accept bare arrays or `{ key: [...] }` wrappers (faq/corpus/scenarios/…). */
export function unwrapCatalogArray(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as Record<string, unknown>)[key])
  ) {
    return (raw as Record<string, unknown>)[key] as unknown[];
  }
  return [];
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
  'queries.json',
  'mutations.json',
  'tours.json',
  'search.json',
  'heuristics.json',
  'normalize.json',
] as const;

function packHasLanguageSurface(packDir: string): boolean {
  return (
    pathExists(join(packDir, 'intents.json')) ||
    pathExists(join(packDir, 'flow.json')) ||
    pathExists(join(packDir, 'queries.json'))
  );
}

/**
 * Prefer `.notlm/pack` when it looks like a real deploy pack; else host pack folder.
 * Manifest-only stubs must not win (including when resolvePackFolder would re-pick the stub).
 */
export function resolveActivePackDir(
  home: string,
  projectRoot: string,
  resolvePackFolder: (root: string) => string
): string {
  const nested = join(home, 'pack');
  if (
    pathExists(join(nested, 'manifest.json')) &&
    packHasLanguageSurface(nested)
  ) {
    return nested;
  }
  const fallback = resolvePackFolder(projectRoot);
  // Avoid circular stub: same empty `.notlm/pack` via resolvePackFolder.
  if (
    fallback === nested ||
    !pathExists(join(fallback, 'manifest.json')) ||
    !packHasLanguageSurface(fallback)
  ) {
    // Prefer host `pack/` when present with a real surface.
    const hostPack = join(projectRoot, 'pack');
    if (
      pathExists(join(hostPack, 'manifest.json')) &&
      packHasLanguageSurface(hostPack)
    ) {
      return hostPack;
    }
  }
  return fallback;
}

/** Load pack JSON pieces from an explicit pack folder (+ home scenarios/config). */
export function loadPackFolderJson(
  home: string,
  packOverride?: string
): Record<string, unknown> {
  const pack = packOverride ?? packDir(home);
  const out: Record<string, unknown> = {};
  for (const file of PACK_PIECES) {
    const p = join(pack, file);
    if (!existsSync(p)) continue;
    const key = file.replace(/\.json$/, '');
    const raw = readJsonFile(p);
    if (file === 'faq.json') out[key] = unwrapCatalogArray(raw, 'faq');
    else if (file === 'corpus.json') out[key] = unwrapCatalogArray(raw, 'corpus');
    else if (file === 'queries.json') out[key] = unwrapCatalogArray(raw, 'queries');
    else if (file === 'mutations.json') out[key] = unwrapCatalogArray(raw, 'mutations');
    else if (file === 'tours.json') out[key] = unwrapCatalogArray(raw, 'tours');
    else if (file === 'search.json') out[key] = unwrapCatalogArray(raw, 'search');
    else if (file === 'lookups.json') out[key] = unwrapCatalogArray(raw, 'lookups');
    else if (file === 'glossary.json') out[key] = unwrapCatalogArray(raw, 'glossary');
    else out[key] = raw;
  }
  for (const file of ['semantic-index.json', 'semantic-index.custom.json'] as const) {
    const p = join(pack, file);
    if (!existsSync(p)) continue;
    out[file.replace(/\.json$/, '')] = readJsonFile(p);
  }
  const configPath = join(home, 'config.json');
  if (existsSync(configPath)) out.config = readJsonFile(configPath);
  const scenariosPath = join(home, 'scenarios.json');
  if (existsSync(scenariosPath)) {
    out.scenarios = unwrapCatalogArray(readJsonFile(scenariosPath), 'scenarios');
  }
  return out;
}

export function copyTemplateFile(src: string, dest: string): void {
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
}
