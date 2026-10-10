/**
 * Heuristics for when to rebuild semantic base index / retrain ranker.
 * Digests are stable hashes of pack language surfaces — no host brand.
 */
import { createHash } from 'node:crypto';
import type { PackJsonInput, ScenarioCase } from '@notlm/core';
import type { SemanticIndex } from '@notlm/core';
import {
  examplesFromCorpus,
  isRankerTrainableCase,
} from '@notlm-training/ranker-train';

/** Must match `buildSemanticIndex` FAQ body window. */
export const SEMANTIC_DIGEST_TEXT_CHARS = 160;

export type DriftDecision = {
  needed: boolean;
  reason: string;
  digest: string;
};

function sha16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** Stable serialization of scenario/corpus expect (object or legacy string). */
export function serializeExpect(expect: unknown): string {
  if (expect == null) return '';
  if (typeof expect === 'string' || typeof expect === 'number' || typeof expect === 'boolean') {
    return String(expect);
  }
  if (typeof expect !== 'object') return String(expect);
  const e = expect as Record<string, unknown>;
  const preferred = [
    'stepId',
    'faqId',
    'queryId',
    'rawIntent',
    'goBack',
    'isCorrection',
    'slots',
  ];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const k of preferred) {
    if (e[k] === undefined) continue;
    seen.add(k);
    parts.push(
      `${k}=${typeof e[k] === 'object' ? JSON.stringify(e[k]) : String(e[k])}`
    );
  }
  for (const k of Object.keys(e).sort()) {
    if (seen.has(k) || e[k] === undefined) continue;
    parts.push(
      `${k}=${typeof e[k] === 'object' ? JSON.stringify(e[k]) : String(e[k])}`
    );
  }
  return parts.join('&');
}

/** Digest of FAQ + query texts that feed the base semantic index. */
export function semanticSourceDigest(pack: PackJsonInput): string {
  const faqRows = (pack.faq ?? [])
    .map((f) => {
      const aliases = [...(f.aliases ?? [])].map((a) => a.trim()).filter(Boolean).sort();
      return `${f.id}\t${aliases.join('|')}\t${(f.text ?? '').slice(0, SEMANTIC_DIGEST_TEXT_CHARS)}`;
    })
    .sort();
  const queryRows = (pack.queries ?? [])
    .map((q) => {
      const aliases = [...(q.aliases ?? [])].map((a) => a.trim()).filter(Boolean).sort();
      return `${q.id}\t${q.title ?? ''}\t${aliases.join('|')}`;
    })
    .sort();
  return sha16(`faq\n${faqRows.join('\n')}\nquery\n${queryRows.join('\n')}`);
}

/** Digest of surfaces that feed ranker training (aliases + labeled corpus). */
export function rankerSourceDigest(
  pack: PackJsonInput,
  corpus: ScenarioCase[] = [],
  scenarios: ScenarioCase[] = []
): string {
  const aliasRows = Object.entries(pack.intents?.aliases ?? {})
    .map(([id, als]) => {
      const sorted = [...(als ?? [])].map((a) => a.trim()).filter(Boolean).sort();
      return `${id}\t${sorted.join('|')}`;
    })
    .sort();
  const labeled = [...corpus, ...scenarios]
    .filter(isRankerTrainableCase)
    .map((c) => `${serializeExpect(c.expect)}\t${String(c.utterance).trim()}`)
    .sort();
  return sha16(`aliases\n${aliasRows.join('\n')}\nlabeled\n${labeled.join('\n')}`);
}

export type SemanticIndexWithDigest = SemanticIndex & { sourceDigest?: string };

/** Rebuild base embed index when missing, empty, or source digest drifted. */
export function decideSemanticRebuild(
  pack: PackJsonInput,
  index: SemanticIndexWithDigest | null | undefined
): DriftDecision {
  const digest = semanticSourceDigest(pack);
  if (!index?.docs?.length) {
    return { needed: true, reason: 'missing_or_empty_index', digest };
  }
  if (index.sourceDigest && index.sourceDigest === digest) {
    return { needed: false, reason: 'digest_match', digest };
  }
  if (index.sourceDigest && index.sourceDigest !== digest) {
    return { needed: true, reason: 'source_drift', digest };
  }
  const expectedIds = new Set([
    ...(pack.faq ?? []).map((f) => f.id),
    ...(pack.queries ?? []).map((q) => q.id),
  ]);
  const indexedIds = new Set(index.docs.map((d) => d.id));
  for (const id of expectedIds) {
    if (!indexedIds.has(id)) {
      return { needed: true, reason: 'missing_doc_ids', digest };
    }
  }
  return { needed: true, reason: 'stamp_digest', digest };
}

export type PipelineState = {
  rankerSourceDigest?: string;
  semanticSourceDigest?: string;
  updatedAt?: string;
};

/** Retrain ranker when missing model, no digest stamp, or alias/corpus drifted. */
export function decideRankerRetrain(opts: {
  pack: PackJsonInput;
  corpus?: ScenarioCase[];
  scenarios?: ScenarioCase[];
  hasRankerJson: boolean;
  state?: PipelineState | null;
  force?: boolean;
  /** @deprecated Prefer examplesFromCorpus; kept for tests that stub surface size. */
  labeledCount?: number;
}): DriftDecision {
  const corpus = opts.corpus ?? [];
  const scenarios = opts.scenarios ?? [];
  const digest = rankerSourceDigest(opts.pack, corpus, scenarios);
  // Same surface as cmdRankerTrain → examplesFromCorpus (skip empty alias phrases).
  const exampleCount =
    opts.labeledCount ??
    examplesFromCorpus(
      [...corpus, ...scenarios],
      opts.pack.intents?.aliases ?? {}
    ).length;
  const hasTrainSurface = exampleCount > 0;

  if (!hasTrainSurface) {
    // Force cannot invent examples — accept/post must not call train (exit 1).
    return { needed: false, reason: 'no_labeled_examples', digest };
  }
  if (opts.force) {
    return { needed: true, reason: 'forced_after_pack_growth', digest };
  }
  if (!opts.hasRankerJson) {
    return { needed: true, reason: 'missing_ranker_json', digest };
  }
  const prev = opts.state?.rankerSourceDigest;
  if (!prev) {
    return { needed: true, reason: 'unstamped_ranker', digest };
  }
  if (prev !== digest) {
    return { needed: true, reason: 'source_drift', digest };
  }
  return { needed: false, reason: 'digest_match', digest };
}
