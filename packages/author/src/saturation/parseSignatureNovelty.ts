import { parseUtterance, type IntentParsePack, type ParseUtteranceResult } from '@notlm/core';
import type { ParseSignatureBucket } from './types.js';

export function parseSignatureFromResult(result: ParseUtteranceResult): ParseSignatureBucket {
  if (result.goBack) return 'go_back';
  if (result.isCorrection) return 'correction';
  if (result.rawIntent === 'ambiguous' || (result.candidates && result.candidates.length >= 2)) {
    return 'clash';
  }
  if (result.stepId) return `step:${result.stepId}`;
  if (result.rawIntent && result.rawIntent !== 'unknown') {
    return `meta:${result.rawIntent}`;
  }
  return 'null';
}

export function parseSignature(utterance: string, pack: IntentParsePack): ParseSignatureBucket {
  return parseSignatureFromResult(parseUtterance(utterance, pack));
}

/**
 * Parse-signature novelty: unseen or rare signatures score higher.
 * score = 1 / (1 + priorCount) so first occurrence = 1, second ≈ 0.5, …
 */
export function parseSignatureNovelty(
  signature: string,
  priorSignatures: readonly string[]
): number {
  let count = 0;
  for (const s of priorSignatures) {
    if (s === signature) count += 1;
  }
  return 1 / (1 + count);
}

export function countSignatures(signatures: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of signatures) {
    map.set(s, (map.get(s) ?? 0) + 1);
  }
  return map;
}
