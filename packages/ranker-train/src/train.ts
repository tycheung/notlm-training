import type { ScenarioCase } from '@notlm/core';
import { featurizeUtterance, type RankerModelJson } from '@notlm/ranker';

export type TrainExample = {
  utterance: string;
  intentLabel: string;
  slotKeys?: string[];
};

export type TrainRankerOptions = {
  dim?: number;
  ngrams?: number[];
  epochs?: number;
  learningRate?: number;
  seed?: number;
};

function labelFromCase(c: ScenarioCase): string {
  if (c.expect.goBack) return 'go_back';
  if (c.expect.rawIntent) return c.expect.rawIntent;
  if (c.expect.stepId) return `goto:${c.expect.stepId}`;
  // FAQ paraphrase rows train the generic faq head (id comes from pack match at infer).
  if (c.expect.faqId) return 'faq';
  return 'unknown';
}

/**
 * Desk-query paraphrase rows are catalog/semantic — not ranker goto/faq heads.
 * Keep in sync with author `rankerSourceDigest` / `decideRankerRetrain` filters.
 */
export function isRankerTrainableCase(c: ScenarioCase): boolean {
  if (!c || typeof c.utterance !== 'string' || !c.expect) return false;
  if (!String(c.utterance).trim()) return false;
  if (
    c.expect.queryId &&
    !c.expect.stepId &&
    !c.expect.faqId &&
    !c.expect.rawIntent &&
    !c.expect.goBack
  ) {
    return false;
  }
  return true;
}

/** Expand corpus + alias phrases into supervised examples. */
export function examplesFromCorpus(
  corpus: ScenarioCase[],
  aliases?: Record<string, string[]>
): TrainExample[] {
  const out: TrainExample[] = [];
  for (const c of corpus) {
    if (!isRankerTrainableCase(c)) continue;
    out.push({
      utterance: String(c.utterance).trim(),
      intentLabel: labelFromCase(c),
      slotKeys: Object.keys(
        ((c.expect as { slots?: Record<string, unknown> }).slots ?? {}) as Record<
          string,
          unknown
        >
      ),
    });
  }
  if (aliases) {
    for (const [stepId, phrases] of Object.entries(aliases)) {
      for (const phrase of phrases) {
        const utterance = String(phrase ?? '').trim();
        if (!utterance) continue;
        out.push({ utterance, intentLabel: `goto:${stepId}`, slotKeys: [] });
      }
    }
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tiny hashed-ngram logistic regression for intents + multi-label slots.
 * Deterministic given seed — suitable for corpus gates / CI.
 */
export function trainRanker(
  examples: TrainExample[],
  opts: TrainRankerOptions = {}
): RankerModelJson {
  if (examples.length === 0) {
    throw new Error('trainRanker: need at least one labeled example');
  }
  const dim = opts.dim ?? 128;
  const ngrams = opts.ngrams ?? [2, 3, 4];
  const epochs = opts.epochs ?? 40;
  const lr = opts.learningRate ?? 0.35;
  const rand = mulberry32(opts.seed ?? 42);

  const intentLabels = [...new Set(examples.map((e) => e.intentLabel))].sort();
  const slotSet = new Set<string>();
  for (const e of examples) for (const k of e.slotKeys ?? []) slotSet.add(k);
  const slotLabels = [...slotSet].sort();

  const C = intentLabels.length;
  const S = slotLabels.length;
  const intentW = new Float64Array(C * dim);
  const intentB = new Float64Array(C);
  const slotW = new Float64Array(S * dim);
  const slotB = new Float64Array(S);

  for (let i = 0; i < intentW.length; i += 1) intentW[i] = (rand() - 0.5) * 0.01;
  for (let i = 0; i < slotW.length; i += 1) slotW[i] = (rand() - 0.5) * 0.01;

  const intentIndex = new Map(intentLabels.map((l, i) => [l, i]));

  const xs = examples.map((e) => featurizeUtterance(e.utterance, dim, ngrams));

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let n = 0; n < examples.length; n += 1) {
      const x = xs[n]!;
      const y = intentIndex.get(examples[n]!.intentLabel)!;
      const logits = new Array<number>(C);
      for (let c = 0; c < C; c += 1) {
        let sum = intentB[c] ?? 0;
        const row = c * dim;
        for (let d = 0; d < dim; d += 1) sum += (intentW[row + d] ?? 0) * (x[d] ?? 0);
        logits[c] = sum;
      }
      const max = Math.max(...logits);
      const exps = logits.map((l) => Math.exp(l - max));
      const z = exps.reduce((a, b) => a + b, 0) || 1;
      const probs = exps.map((e) => e / z);

      for (let c = 0; c < C; c += 1) {
        const grad = (probs[c] ?? 0) - (c === y ? 1 : 0);
        intentB[c] = (intentB[c] ?? 0) - lr * grad;
        const row = c * dim;
        for (let d = 0; d < dim; d += 1) {
          intentW[row + d] = (intentW[row + d] ?? 0) - lr * grad * (x[d] ?? 0);
        }
      }

      const active = new Set(examples[n]!.slotKeys ?? []);
      for (let s = 0; s < S; s += 1) {
        let sum = slotB[s] ?? 0;
        const row = s * dim;
        for (let d = 0; d < dim; d += 1) sum += (slotW[row + d] ?? 0) * (x[d] ?? 0);
        const p = 1 / (1 + Math.exp(-sum));
        const target = active.has(slotLabels[s]!) ? 1 : 0;
        const grad = p - target;
        slotB[s] = (slotB[s] ?? 0) - lr * grad;
        for (let d = 0; d < dim; d += 1) {
          slotW[row + d] = (slotW[row + d] ?? 0) - lr * grad * (x[d] ?? 0);
        }
      }
    }
  }

  return {
    version: 1,
    dim,
    ngrams,
    intentLabels,
    intentW: [...intentW],
    intentB: [...intentB],
    slotLabels,
    slotW: [...slotW],
    slotB: [...slotB],
    trainedAt: new Date().toISOString(),
    exampleCount: examples.length,
  };
}
