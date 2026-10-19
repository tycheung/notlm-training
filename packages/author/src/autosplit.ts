/**
 * ADR-011 autosplit: on confident FP overlap, bifurcate leaf label sets and
 * apply to host pack during `auto` (no human accept).
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ConfusionPair = {
  expected: string;
  predicted: string;
  count: number;
  /** Mean confidence of wrong predictions (0–1). */
  meanConfidence: number;
};

export type AutosplitOpts = {
  /** Min FP count for a pair to be considered. */
  minSupport?: number;
  /** Min mean confidence on FPs. */
  minConfidence?: number;
  /** Current tree depth (stop when >= maxDepth). */
  depth?: number;
  maxDepth?: number;
};

export type AutosplitPlan = {
  parentLeaf: string;
  childA: string;
  childB: string;
  labelsA: string[];
  labelsB: string[];
  pair: ConfusionPair;
  reason: string;
};

const DEFAULT_MIN_SUPPORT = 4;
const DEFAULT_MIN_CONF = 0.65;
const DEFAULT_MAX_DEPTH = 3;

/**
 * Pick the highest-overlap confident FP pair and propose a binary leaf split.
 * Labels that only appear on one side stay there; shared → assigned by majority.
 */
export function proposeAutosplit(
  pairs: ConfusionPair[],
  labelUniverse: string[],
  opts: AutosplitOpts = {}
): AutosplitPlan | null {
  const minSupport = opts.minSupport ?? DEFAULT_MIN_SUPPORT;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONF;
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (depth >= maxDepth) return null;

  const ranked = [...pairs]
    .filter((p) => p.count >= minSupport && p.meanConfidence >= minConf)
    .filter((p) => p.expected !== p.predicted)
    .sort(
      (a, b) =>
        b.count * b.meanConfidence - a.count * a.meanConfidence ||
        b.count - a.count
    );
  const top = ranked[0];
  if (!top) return null;

  const a = top.expected;
  const b = top.predicted;
  // Cluster: labels that co-confuse with a vs b (simple: only the pair + orphans)
  const labelsA = labelUniverse.filter((l) => l === a || (!labelUniverse.includes(b) && l.startsWith(a)));
  const labelsB = labelUniverse.filter((l) => l === b);
  const rest = labelUniverse.filter((l) => l !== a && l !== b);
  // Put rest with whichever side shares prefix (goto:*)
  for (const l of rest) {
    if (l.startsWith(a.split(':')[0] + ':') && a.includes(':')) labelsA.push(l);
    else if (l.startsWith(b.split(':')[0] + ':') && b.includes(':')) labelsB.push(l);
    else if (labelsA.length <= labelsB.length) labelsA.push(l);
    else labelsB.push(l);
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  const la = uniq(labelsA);
  const lb = uniq(labelsB);
  if (la.length === 0 || lb.length === 0) return null;

  const stem = a.includes(':') ? a.split(':')[0] : 'leaf';
  return {
    parentLeaf: stem,
    childA: `${stem}__a`,
    childB: `${stem}__b`,
    labelsA: la,
    labelsB: lb,
    pair: top,
    reason: `confident FP ${a}↔${b} n=${top.count} conf=${top.meanConfidence.toFixed(2)}`,
  };
}

export type ApplyAutosplitResult = {
  applied: boolean;
  plan: AutosplitPlan | null;
  reportPath?: string;
  routingTreePath?: string;
};

/**
 * Write routingTree patch + split report into host pack / train-auto.
 * Does not retrain — caller runs ranker post after.
 */
export function applyAutosplitToPack(input: {
  packDir: string;
  homeDir: string;
  plan: AutosplitPlan;
  depth?: number;
}): ApplyAutosplitResult {
  const { packDir, homeDir, plan } = input;
  const reportDir = join(homeDir, 'train-auto');
  mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(reportDir, `autosplit-${stamp}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify({ t: new Date().toISOString(), plan, depth: input.depth ?? 0 }, null, 2),
    'utf8'
  );

  const treePath = join(packDir, 'routingTree.json');
  let tree: Record<string, unknown> = {
    enabled: true,
    planeSoftBiasBelow: 0.55,
    autosplitMaxDepth: DEFAULT_MAX_DEPTH,
    leaves: {},
  };
  if (existsSync(treePath)) {
    try {
      tree = JSON.parse(readFileSync(treePath, 'utf8')) as Record<string, unknown>;
    } catch {
      /* keep default */
    }
  }
  const leaves =
    tree.leaves && typeof tree.leaves === 'object' && !Array.isArray(tree.leaves)
      ? { ...(tree.leaves as Record<string, string>) }
      : {};
  leaves[plan.childA] = `ranker.leaves.${plan.childA}`;
  leaves[plan.childB] = `ranker.leaves.${plan.childB}`;
  // Keep parent pointer for docs; runtime uses leaf files when present.
  leaves[plan.parentLeaf] = leaves[plan.parentLeaf] ?? `ranker.leaves.${plan.parentLeaf}`;
  tree.leaves = leaves;
  tree.enabled = true;
  tree.lastAutosplit = {
    at: new Date().toISOString(),
    reason: plan.reason,
    childA: plan.childA,
    childB: plan.childB,
    labelsA: plan.labelsA,
    labelsB: plan.labelsB,
  };
  writeFileSync(treePath, JSON.stringify(tree, null, 2) + '\n', 'utf8');

  // Corpus split tags file for ranker-train multi-stage
  const splitMetaPath = join(packDir, `autosplit.${plan.parentLeaf}.json`);
  writeFileSync(
    splitMetaPath,
    JSON.stringify(
      {
        parent: plan.parentLeaf,
        childA: { id: plan.childA, labels: plan.labelsA },
        childB: { id: plan.childB, labels: plan.labelsB },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  return {
    applied: true,
    plan,
    reportPath,
    routingTreePath: treePath,
  };
}

/**
 * Size-gate: when a leaf label universe exceeds maxLabels, propose a binary split.
 * Used by `auto` even when hardFails=0 so large packs get submodels.
 */
export function proposeSizeAutosplit(
  labels: string[],
  parentLeaf: string,
  opts: { maxLabels?: number; depth?: number; maxDepth?: number } = {}
): AutosplitPlan | null {
  const maxLabels = opts.maxLabels ?? 16;
  const depth = opts.depth ?? 0;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (depth >= maxDepth) return null;
  const uniq = [...new Set(labels.filter(Boolean))].sort();
  if (uniq.length <= maxLabels) return null;
  const mid = Math.ceil(uniq.length / 2);
  const labelsA = uniq.slice(0, mid);
  const labelsB = uniq.slice(mid);
  if (labelsA.length < 2 || labelsB.length < 2) return null;
  return {
    parentLeaf,
    childA: `${parentLeaf}__a`,
    childB: `${parentLeaf}__b`,
    labelsA,
    labelsB,
    pair: {
      expected: labelsA[0]!,
      predicted: labelsB[0]!,
      count: uniq.length,
      meanConfidence: 1,
    },
    reason: `size_gate ${parentLeaf} labels=${uniq.length}>${maxLabels}`,
  };
}

/** Build confusion pairs from eval rows (expected vs predicted label). */
export function confusionFromEvalRows(
  rows: Array<{ expected: string; predicted: string; confidence?: number }>
): ConfusionPair[] {
  const map = new Map<string, { count: number; confSum: number }>();
  for (const r of rows) {
    if (!r.expected || !r.predicted || r.expected === r.predicted) continue;
    const key = `${r.expected}\t${r.predicted}`;
    const cur = map.get(key) ?? { count: 0, confSum: 0 };
    cur.count += 1;
    cur.confSum += r.confidence ?? 0.7;
    map.set(key, cur);
  }
  return [...map.entries()].map(([key, v]) => {
    const [expected, predicted] = key.split('\t');
    return {
      expected,
      predicted,
      count: v.count,
      meanConfidence: v.confSum / v.count,
    };
  });
}
