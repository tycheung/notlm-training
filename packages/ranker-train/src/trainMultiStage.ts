/**
 * Multi-stage ranker training (ADR-011): plane + lane + per-lane leaves.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_LANES,
  inferPlaneHeuristic,
  laneFromRawIntent,
  type CapabilityLane,
  type ScenarioCase,
} from '@notlm/core';
import { trainRanker, examplesFromCorpus, type TrainExample } from './train.js';

const MIN_EXAMPLES = 3;
/** Split a leaf when it has more distinct labels than this (training autosplit). */
export const DEFAULT_MAX_LEAF_LABELS = 16;
/** Or when a single leaf has more supervised rows than this. */
export const DEFAULT_MAX_LEAF_EXAMPLES = 2000;

export function planeExamplesFromCorpus(corpus: ScenarioCase[]): TrainExample[] {
  const out: TrainExample[] = [];
  for (const c of corpus) {
    const u = String(c.utterance ?? '').trim();
    if (!u) continue;
    const plane = inferPlaneHeuristic(u).plane;
    out.push({ utterance: u, intentLabel: plane, slotKeys: [] });
  }
  return out;
}

function laneForExample(ex: TrainExample): CapabilityLane | null {
  const label = ex.intentLabel;
  if (label === 'ask' || label === 'guide' || label === 'do') return null;
  if (label === 'faq') return 'faq';
  if (label === 'go_back' || label === 'whats_next' || label === 'help') {
    return 'context';
  }
  if (label === 'ood' || label === 'refuse') return 'ood';
  if (label.startsWith('goto:') || label.startsWith('open:') || label.startsWith('nav:')) {
    return 'goto';
  }
  if (label.startsWith('query') || label === 'data_query') return 'query';
  if (label.startsWith('mutate') || label === 'mutation') {
    // Generic risk cues only — no host-product intent ids in ranker-train.
    return /delete|destroy|purge|wipe|high_risk|mutation_high/i.test(label)
      ? 'mutation_high_risk'
      : 'mutation';
  }
  if (label === 'tour' || label.startsWith('tour:')) return 'tour';
  if (label === 'search' || label.startsWith('search:')) return 'search';
  if (label === 'compare' || label.includes('vs')) return 'compare';
  if (label === 'handoff') return 'handoff';
  if (label === 'audit' || label === 'explain_field') return 'audit';
  if (label === 'unknown' || label === 'ambiguous') return 'disambiguation';
  return (
    laneFromRawIntent(label, {
      faqId: label === 'faq' ? 'faq' : null,
      mutationId: label.startsWith('mutate') ? label : null,
    }) ?? null
  );
}

export function laneExamplesFromCorpus(
  corpus: ScenarioCase[],
  aliases?: Record<string, string[]>
): TrainExample[] {
  const leafEx = examplesFromCorpus(corpus, aliases);
  const out: TrainExample[] = [];
  for (const ex of leafEx) {
    const lane = laneForExample(ex);
    if (!lane) continue;
    out.push({ utterance: ex.utterance, intentLabel: lane, slotKeys: [] });
  }
  // Plane-shaped utterances also teach lane mask priors lightly via heuristic plane→default lane
  for (const c of corpus) {
    const u = String(c.utterance ?? '').trim();
    if (!u) continue;
    const plane = inferPlaneHeuristic(u).plane;
    const lane: CapabilityLane =
      plane === 'do' ? 'mutation' : plane === 'guide' ? 'goto' : 'faq';
    out.push({ utterance: u, intentLabel: lane, slotKeys: [] });
  }
  return out;
}

export function leafExamplesByLane(
  corpus: ScenarioCase[],
  aliases?: Record<string, string[]>
): Map<CapabilityLane, TrainExample[]> {
  const leafEx = examplesFromCorpus(corpus, aliases);
  const map = new Map<CapabilityLane, TrainExample[]>();
  for (const lane of CAPABILITY_LANES) map.set(lane, []);
  for (const ex of leafEx) {
    const lane = laneForExample(ex);
    if (!lane) continue;
    map.get(lane)!.push(ex);
  }
  return map;
}

export type MultiStageWriteResult = {
  planePath: string;
  lanePath: string;
  leafPaths: string[];
  flatPath: string;
  splitsApplied: string[];
};

function writeModel(path: string, examples: TrainExample[], dim: number, epochs: number): boolean {
  if (examples.length < MIN_EXAMPLES) return false;
  const model = trainRanker(examples, { dim, epochs, seed: 42 });
  writeFileSync(path, `${JSON.stringify(model, null, 2)}\n`, 'utf8');
  return true;
}

/** Deterministic bipartition of labels for size-gated leaf split. */
export function bipartitionLabels(labels: string[]): { a: string[]; b: string[] } {
  const sorted = [...new Set(labels)].sort();
  if (sorted.length < 4) return { a: sorted, b: [] };
  const mid = Math.ceil(sorted.length / 2);
  return { a: sorted.slice(0, mid), b: sorted.slice(mid) };
}

type AutosplitMeta = {
  parent: string;
  childA: { id: string; labels: string[] };
  childB: { id: string; labels: string[] };
};

/** Read pack `autosplit.<leaf>.json` written by `auto` / prior size gates. */
export function readAutosplitMeta(
  packDir: string,
  parentLane: string
): AutosplitMeta | null {
  const metaPath = join(packDir, `autosplit.${parentLane}.json`);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as AutosplitMeta;
    if (
      !raw?.childA?.id ||
      !raw?.childB?.id ||
      !Array.isArray(raw.childA.labels) ||
      !Array.isArray(raw.childB.labels)
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function applySizeSplitMeta(
  packDir: string,
  parentLane: string,
  labelsA: string[],
  labelsB: string[]
): { childA: string; childB: string } {
  const childA = `${parentLane}__a`;
  const childB = `${parentLane}__b`;
  const metaPath = join(packDir, `autosplit.${parentLane}.json`);
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        parent: parentLane,
        childA: { id: childA, labels: labelsA },
        childB: { id: childB, labels: labelsB },
        reason: `size_gate labels=${labelsA.length + labelsB.length}`,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  return { childA, childB };
}

function patchRoutingTreeLeaves(
  packDir: string,
  leaves: Record<string, string>
): void {
  const treePath = join(packDir, 'routingTree.json');
  let tree: Record<string, unknown> = {
    enabled: true,
    planeSoftBiasBelow: 0.55,
    leaves: {},
  };
  if (existsSync(treePath)) {
    try {
      tree = JSON.parse(readFileSync(treePath, 'utf8')) as Record<string, unknown>;
    } catch {
      /* keep default */
    }
  }
  const prev =
    tree.leaves && typeof tree.leaves === 'object' && !Array.isArray(tree.leaves)
      ? { ...(tree.leaves as Record<string, string>) }
      : {};
  tree.leaves = { ...prev, ...leaves };
  tree.enabled = true;
  writeFileSync(treePath, `${JSON.stringify(tree, null, 2)}\n`, 'utf8');
}

/**
 * Train plane / lane / per-lane leaf rankers (+ flat fallback).
 * Size-gates large leaves into `__a`/`__b` specialists and patches routingTree.
 */
export function writeMultiStageRankers(input: {
  packDir: string;
  corpus: ScenarioCase[];
  aliases?: Record<string, string[]>;
  maxLeafLabels?: number;
  maxLeafExamples?: number;
  epochs?: number;
  dim?: number;
}): MultiStageWriteResult {
  mkdirSync(input.packDir, { recursive: true });
  const epochs = input.epochs ?? 40;
  const dim = input.dim ?? 128;
  const maxLeafLabels = input.maxLeafLabels ?? DEFAULT_MAX_LEAF_LABELS;
  const maxLeafExamples = input.maxLeafExamples ?? DEFAULT_MAX_LEAF_EXAMPLES;
  const leafPaths: string[] = [];
  const splitsApplied: string[] = [];
  const leafPointers: Record<string, string> = {};

  const planePath = join(input.packDir, 'ranker.plane.json');
  writeModel(planePath, planeExamplesFromCorpus(input.corpus), 64, Math.min(30, epochs));

  const lanePath = join(input.packDir, 'ranker.lane.json');
  writeModel(
    lanePath,
    laneExamplesFromCorpus(input.corpus, input.aliases),
    64,
    Math.min(30, epochs)
  );

  const byLane = leafExamplesByLane(input.corpus, input.aliases);
  for (const lane of CAPABILITY_LANES) {
    const examples = byLane.get(lane) ?? [];
    if (examples.length < MIN_EXAMPLES) continue;
    const labels = [...new Set(examples.map((e) => e.intentLabel))];
    // Prefer pack autosplit meta from `auto` (FP or size) so retrain matches tree.
    const prior = readAutosplitMeta(input.packDir, lane);
    const oversized =
      labels.length > maxLeafLabels || examples.length > maxLeafExamples;
    if (prior && prior.childA.labels.length && prior.childB.labels.length) {
      const a = prior.childA.labels;
      const b = prior.childB.labels;
      const childA = prior.childA.id;
      const childB = prior.childB.id;
      const exA = examples.filter((e) => a.includes(e.intentLabel));
      const exB = examples.filter((e) => b.includes(e.intentLabel));
      const pathA = join(input.packDir, `ranker.leaves.${childA}.json`);
      const pathB = join(input.packDir, `ranker.leaves.${childB}.json`);
      if (writeModel(pathA, exA.length >= MIN_EXAMPLES ? exA : examples, dim, epochs)) {
        leafPaths.push(pathA);
        leafPointers[childA] = `ranker.leaves.${childA}`;
      }
      if (writeModel(pathB, exB.length >= MIN_EXAMPLES ? exB : examples, dim, epochs)) {
        leafPaths.push(pathB);
        leafPointers[childB] = `ranker.leaves.${childB}`;
      }
      const parentPath = join(input.packDir, `ranker.leaves.${lane}.json`);
      if (writeModel(parentPath, examples, dim, epochs)) {
        leafPaths.push(parentPath);
        leafPointers[lane] = `ranker.leaves.${lane}`;
      }
      splitsApplied.push(`${lane}→${childA}/${childB} (meta)`);
      continue;
    }
    if (oversized) {
      const { a, b } = bipartitionLabels(labels);
      if (b.length >= 2) {
        const { childA, childB } = applySizeSplitMeta(input.packDir, lane, a, b);
        const exA = examples.filter((e) => a.includes(e.intentLabel));
        const exB = examples.filter((e) => b.includes(e.intentLabel));
        const pathA = join(input.packDir, `ranker.leaves.${childA}.json`);
        const pathB = join(input.packDir, `ranker.leaves.${childB}.json`);
        if (writeModel(pathA, exA, dim, epochs)) {
          leafPaths.push(pathA);
          leafPointers[childA] = `ranker.leaves.${childA}`;
        }
        if (writeModel(pathB, exB, dim, epochs)) {
          leafPaths.push(pathB);
          leafPointers[childB] = `ranker.leaves.${childB}`;
        }
        // Keep parent aggregate for hosts that have not switched to children yet.
        const parentPath = join(input.packDir, `ranker.leaves.${lane}.json`);
        if (writeModel(parentPath, examples, dim, epochs)) {
          leafPaths.push(parentPath);
          leafPointers[lane] = `ranker.leaves.${lane}`;
        }
        splitsApplied.push(`${lane}→${childA}/${childB}`);
        continue;
      }
    }
    const leafPath = join(input.packDir, `ranker.leaves.${lane}.json`);
    if (writeModel(leafPath, examples, dim, epochs)) {
      leafPaths.push(leafPath);
      leafPointers[lane] = `ranker.leaves.${lane}`;
    }
  }

  const flatPath = join(input.packDir, 'ranker.json');
  const allLeaf = examplesFromCorpus(input.corpus, input.aliases);
  writeModel(flatPath, allLeaf, dim, epochs);

  if (Object.keys(leafPointers).length) {
    patchRoutingTreeLeaves(input.packDir, leafPointers);
  }

  return { planePath, lanePath, leafPaths, flatPath, splitsApplied };
}
