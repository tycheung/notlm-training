export function normalizeForNovelty(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charNgrams(s: string, n: number): Set<string> {
  const grams = new Set<string>();
  if (s.length < n) {
    if (s.length > 0) grams.add(s);
    return grams;
  }
  for (let i = 0; i <= s.length - n; i++) {
    grams.add(s.slice(i, i + n));
  }
  return grams;
}

function wordNgrams(s: string, n: number): Set<string> {
  const words = s.split(' ').filter(Boolean);
  const grams = new Set<string>();
  if (words.length < n) {
    if (words.length > 0) grams.add(words.join(' '));
    return grams;
  }
  for (let i = 0; i <= words.length - n; i++) {
    grams.add(words.slice(i, i + n).join(' '));
  }
  return grams;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Lexical novelty vs nearest prior utterance in [0, 1].
 * 1 = maximally different; 0 = near-duplicate paraphrase.
 */
export function lexicalNovelty(
  utterance: string,
  priorUtterances: readonly string[],
  opts?: { charN?: number; wordN?: number }
): number {
  const charN = opts?.charN ?? 3;
  const wordN = opts?.wordN ?? 2;
  const norm = normalizeForNovelty(utterance);
  if (!norm) return 0;
  if (priorUtterances.length === 0) return 1;

  const selfChar = charNgrams(norm, charN);
  const selfWord = wordNgrams(norm, wordN);
  let maxSim = 0;

  for (const prior of priorUtterances) {
    const p = normalizeForNovelty(prior);
    if (!p) continue;
    if (p === norm) return 0;
    const sim =
      0.5 * jaccard(selfChar, charNgrams(p, charN)) +
      0.5 * jaccard(selfWord, wordNgrams(p, wordN));
    if (sim > maxSim) maxSim = sim;
  }

  return Math.max(0, Math.min(1, 1 - maxSim));
}
