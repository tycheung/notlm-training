/**
 * Shared pack payload for checkIntents — parity with notlm CLI cmdIntentsCheck.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(
      `Invalid JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Parity with notlm/packages/cli/src/cmdIntentsCheck.ts readJsonCatalog. */
function readJsonCatalog(path: string, key: string): unknown[] | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readJsonIfExists(path);
  if (Array.isArray(raw)) return raw;
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as Record<string, unknown>)[key])
  ) {
    return (raw as Record<string, unknown>)[key] as unknown[];
  }
  return undefined;
}

/** Build checkIntents pack + features from loaded home files (+ optional pack dir). */
export function checkIntentsInputFromFiles(
  files: Record<string, unknown>,
  packPath: string
): {
  pack: Record<string, unknown>;
  features: unknown;
} {
  const configFeatures = (files.config as { features?: unknown } | undefined)
    ?.features;
  const queries = Array.isArray(files.queries)
    ? files.queries
    : readJsonCatalog(join(packPath, 'queries.json'), 'queries');
  return {
    pack: {
      manifest: files.manifest,
      flow: files.flow,
      controls: files.controls ?? [],
      intents: files.intents,
      binders: files.binders,
      faq: Array.isArray(files.faq) && files.faq.length > 0
        ? files.faq
        : readJsonCatalog(join(packPath, 'faq.json'), 'faq'),
      queries,
      mutations:
        files.mutations ??
        readJsonCatalog(join(packPath, 'mutations.json'), 'mutations'),
      tours:
        files.tours ?? readJsonCatalog(join(packPath, 'tours.json'), 'tours'),
      search:
        files.search ?? readJsonCatalog(join(packPath, 'search.json'), 'search'),
      heuristics:
        files.heuristics ?? readJsonIfExists(join(packPath, 'heuristics.json')),
      normalize:
        files.normalize ?? readJsonIfExists(join(packPath, 'normalize.json')),
      semanticIndex:
        files['semantic-index'] ??
        readJsonIfExists(join(packPath, 'semantic-index.json')),
      semanticIndexCustom:
        files['semantic-index.custom'] ??
        readJsonIfExists(join(packPath, 'semantic-index.custom.json')),
    },
    features: configFeatures,
  };
}
