/**
 * Diversity gate: hashed bag-of-ngrams vectors + lexical novelty.
 * Optional BYO embeddings via env later; hashed vectors work offline / fixture.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lexicalNovelty, normalizeForNovelty } from '../saturation/lexicalNovelty.js';

export type VectorRecord = {
  id: string;
  utterance: string;
  vector: number[];
  at: string;
};

export type VectorStore = {
  dim: number;
  items: VectorRecord[];
};

const DEFAULT_DIM = 64;

export function hashEmbed(text: string, dim = DEFAULT_DIM): number[] {
  const norm = normalizeForNovelty(text);
  const vec = new Array(dim).fill(0) as number[];
  if (!norm) return vec;
  const tokens = `${norm} ${norm.replace(/\s/g, '')}`;
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i <= tokens.length - n; i += 1) {
      const gram = tokens.slice(i, i + n);
      let h = 2166136261;
      for (let j = 0; j < gram.length; j += 1) {
        h ^= gram.charCodeAt(j)!;
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % dim;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
  }
  return l2Normalize(vec);
}

function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const n = Math.sqrt(sum);
  if (n < 1e-12) return vec;
  return vec.map((v) => v / n);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export function loadVectorStore(path: string): VectorStore {
  if (!existsSync(path)) return { dim: DEFAULT_DIM, items: [] };
  const raw = JSON.parse(readFileSync(path, 'utf8')) as VectorStore;
  return {
    dim: raw.dim || DEFAULT_DIM,
    items: Array.isArray(raw.items) ? raw.items : [],
  };
}

export function saveVectorStore(path: string, store: VectorStore): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export type DiversityDecision = {
  accept: boolean;
  reason: string;
  maxSimilarity: number;
  lexicalNovelty: number;
};

export function diversityGate(input: {
  utterance: string;
  store: VectorStore;
  priorUtterances: readonly string[];
  maxSimilarity: number;
  minLexicalNovelty: number;
}): DiversityDecision {
  const vec = hashEmbed(input.utterance, input.store.dim);
  let maxSim = 0;
  for (const item of input.store.items) {
    const sim = cosineSimilarity(vec, item.vector);
    if (sim > maxSim) maxSim = sim;
  }
  const lex = lexicalNovelty(input.utterance, input.priorUtterances);
  if (maxSim >= input.maxSimilarity) {
    return {
      accept: false,
      reason: `near-duplicate cosine=${maxSim.toFixed(3)}`,
      maxSimilarity: maxSim,
      lexicalNovelty: lex,
    };
  }
  if (lex < input.minLexicalNovelty) {
    return {
      accept: false,
      reason: `low lexical novelty=${lex.toFixed(3)}`,
      maxSimilarity: maxSim,
      lexicalNovelty: lex,
    };
  }
  return {
    accept: true,
    reason: 'ok',
    maxSimilarity: maxSim,
    lexicalNovelty: lex,
  };
}

export function appendToVectorStore(
  store: VectorStore,
  utterance: string,
  id: string
): VectorStore {
  const vector = hashEmbed(utterance, store.dim);
  return {
    ...store,
    items: [
      ...store.items,
      { id, utterance, vector, at: new Date().toISOString() },
    ],
  };
}

export function vectorsPath(trainAutoDir: string): string {
  return join(trainAutoDir, 'vectors.json');
}
