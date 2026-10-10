/**
 * Append miss-cluster paraphrase texts into pack/semantic-index.custom.json.
 * Never overwrites base semantic-index.json.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SEMANTIC_DIM,
  SEMANTIC_INDEX_CUSTOM_FILE,
  SEMANTIC_INDEX_VERSION,
  embedText,
  type SemanticDoc,
  type SemanticIndex,
} from '@notlm/core';

/** Minimal cluster shape (avoids author → recalibrate dependency). */
export type CustomIndexCluster = {
  centroid: string;
  members: string[];
  nearest?: { id: string; kind: 'faq' | 'query'; similarity: number };
};

function meanVector(vectors: Float32Array[], dim: number): number[] {
  const acc = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
  }
  const scale = vectors.length || 1;
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    const scaled = (acc[i] ?? 0) / scale;
    acc[i] = scaled;
    norm += scaled ** 2;
  }
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i += 1) out[i] = (acc[i] ?? 0) / norm;
  return out;
}

function readCustom(path: string, dim: number): SemanticIndex {
  if (!existsSync(path)) {
    return { version: SEMANTIC_INDEX_VERSION, dim, layer: 'custom', docs: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as SemanticIndex;
    if (!Array.isArray(raw.docs)) {
      throw new Error('docs is not an array');
    }
    return {
      version: SEMANTIC_INDEX_VERSION,
      dim: raw.dim || dim,
      layer: 'custom',
      docs: raw.docs,
      sourceDigest: raw.sourceDigest,
    };
  } catch (err) {
    const bak = `${path}.corrupt-${Date.now()}.bak`;
    try {
      copyFileSync(path, bak);
    } catch {
      /* best-effort backup */
    }
    throw new Error(
      `Corrupt ${path}; refusing to wipe overlay. Backup: ${bak}. Fix or delete the file. (${
        err instanceof Error ? err.message : String(err)
      })`
    );
  }
}

/**
 * Merge cluster member utterances into custom docs keyed by nearest faq/query id.
 * Only clusters with a nearest match (similarity >= minSim) are written.
 */
export function writeCustomSemanticFromClusters(
  packDir: string,
  clusters: CustomIndexCluster[],
  opts?: { minSimilarity?: number; dim?: number }
): { path: string; docsAdded: number; docsTotal: number } {
  const dim = opts?.dim ?? DEFAULT_SEMANTIC_DIM;
  const minSim = opts?.minSimilarity ?? 0.55;
  if (!existsSync(packDir)) {
    throw new Error(`Missing pack dir: ${packDir}`);
  }
  mkdirSync(packDir, { recursive: true });
  const outPath = join(packDir, SEMANTIC_INDEX_CUSTOM_FILE);
  const custom = readCustom(outPath, dim);
  if ((custom.dim || dim) !== dim) {
    throw new Error(
      `Custom semantic index dim=${custom.dim} != expected ${dim}; rebuild custom or match base dim`
    );
  }
  const byKey = new Map<string, SemanticDoc>();
  for (const doc of custom.docs) {
    if (doc?.id) byKey.set(`${doc.kind}:${doc.id}`, doc);
  }

  let docsAdded = 0;
  for (const c of clusters) {
    const nearest = c.nearest;
    if (!nearest || nearest.similarity < minSim) continue;
    const key = `${nearest.kind}:${nearest.id}`;
    const prev = byKey.get(key);
    const texts = [
      ...(prev?.texts ?? []),
      c.centroid,
      ...c.members,
    ]
      .map((t) => String(t).trim())
      .filter(Boolean);
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const t of texts) {
      const k = t.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(t);
      if (uniq.length >= 48) break;
    }
    if (!uniq.length) continue;
    const wasNew = !prev;
    const vectors = uniq.map((t) => embedText(t, dim));
    byKey.set(key, {
      id: nearest.id,
      kind: nearest.kind,
      texts: uniq,
      vector: meanVector(vectors, dim),
    });
    if (wasNew) docsAdded += 1;
  }

  const next: SemanticIndex = {
    version: SEMANTIC_INDEX_VERSION,
    dim,
    layer: 'custom',
    docs: [...byKey.values()],
  };
  writeFileSync(outPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { path: outPath, docsAdded, docsTotal: next.docs.length };
}
