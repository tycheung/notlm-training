/**
 * Offline miss clustering → alias / ranker training candidates.
 * Uses @notlm/core token overlap (no host brand).
 */
import {
  buildSemanticIndex,
  contentTokens,
  normalizeAsk,
  retrieveSemantic,
  type FaqEntry,
  type MissRecord,
  type SemanticIndex,
} from '@notlm/core';

type QueryLike = { id: string; title?: string; aliases?: string[] };

export type MissCluster = {
  id: string;
  centroid: string;
  members: string[];
  count: number;
  kinds: Record<string, number>;
  /** Nearest pack FAQ/query when an index is provided. */
  nearest?: { id: string; kind: 'faq' | 'query'; similarity: number; tokenOverlap: number };
};

export type MissClusterDraft = {
  note: string;
  clusters: MissCluster[];
  /** Proposed FAQ aliases keyed by faq id (centroid + members). */
  proposedFaqAliases: Record<string, string[]>;
  /** Proposed step/query aliases for ranker corpus. */
  proposedAliases: Record<string, string[]>;
  proposedCorpus: Array<{
    utterance: string;
    expect: { stepId: string | null; faqId?: string; queryId?: string };
  }>;
  singletonCount: number;
};

function jaccardTokens(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 0;
}

/**
 * Greedy clustering of miss utterances by content-token Jaccard.
 */
export function clusterMissRecords(
  records: MissRecord[],
  opts?: { minJaccard?: number; maxClusters?: number }
): MissCluster[] {
  const minJ = opts?.minJaccard ?? 0.45;
  const maxClusters = opts?.maxClusters ?? 80;
  const items: Array<{ text: string; kind: string; tokens: string[] }> = [];
  const seen = new Set<string>();
  for (const r of records) {
    const text = (r.text ?? '').trim();
    if (!text) continue;
    const key = normalizeAsk(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({
      text,
      kind: String(r.kind ?? 'unknown'),
      tokens: contentTokens(text),
    });
  }

  const clusters: MissCluster[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < items.length && clusters.length < maxClusters; i += 1) {
    if (assigned.has(i)) continue;
    const seed = items[i]!;
    const memberIdx = [i];
    assigned.add(i);
    for (let j = i + 1; j < items.length; j += 1) {
      if (assigned.has(j)) continue;
      const other = items[j]!;
      if (jaccardTokens(seed.tokens, other.tokens) >= minJ) {
        memberIdx.push(j);
        assigned.add(j);
      }
    }
    const members = memberIdx.map((ix) => items[ix]!.text);
    // Centroid = longest member (more context for alias drafting).
    const centroid = [...members].sort((a, b) => b.length - a.length)[0]!;
    const kinds: Record<string, number> = {};
    for (const ix of memberIdx) {
      const k = items[ix]!.kind;
      kinds[k] = (kinds[k] ?? 0) + 1;
    }
    clusters.push({
      id: `cluster-${clusters.length + 1}`,
      centroid,
      members,
      count: members.length,
      kinds,
    });
  }

  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

/** Attach nearest FAQ/query via semantic retrieve for each cluster centroid. */
export function annotateClustersWithPack(
  clusters: MissCluster[],
  pack: { faq?: FaqEntry[]; queries?: QueryLike[]; semanticIndex?: SemanticIndex | null }
): MissCluster[] {
  const index =
    pack.semanticIndex ??
    buildSemanticIndex({
      faq: pack.faq,
      queries: (pack.queries ?? []).map((q) => ({
        id: q.id,
        title: q.title ?? q.id,
        aliases: q.aliases ?? [],
      })),
    });
  return clusters.map((c) => {
    const hit = retrieveSemantic(c.centroid, index, {
      minSimilarity: 0.99,
      minTokenOverlap: 0.99,
    });
    const top = hit.candidates[0];
    if (!top) return c;
    return {
      ...c,
      nearest: {
        id: top.id,
        kind: top.kind,
        similarity: top.similarity,
        tokenOverlap: top.tokenOverlap,
      },
    };
  });
}

/**
 * Turn clusters into alias / ranker training draft (human review before fold).
 */
export function draftFromMissClusters(
  clusters: MissCluster[],
  opts?: { minCountForAlias?: number }
): MissClusterDraft {
  const minCount = opts?.minCountForAlias ?? 1;
  const proposedFaqAliases: Record<string, string[]> = {};
  const proposedAliases: Record<string, string[]> = {};
  const proposedCorpus: MissClusterDraft['proposedCorpus'] = [];
  let singletonCount = 0;

  for (const c of clusters) {
    if (c.count < minCount) continue;
    if (c.count === 1) singletonCount += 1;
    const nearest = c.nearest;
    if (nearest?.kind === 'faq' && nearest.similarity >= 0.55) {
      const list = (proposedFaqAliases[nearest.id] ??= []);
      for (const m of c.members) {
        if (!list.includes(m)) list.push(m);
        proposedCorpus.push({
          utterance: m,
          expect: { stepId: null, faqId: nearest.id },
        });
      }
      continue;
    }
    if (nearest?.kind === 'query' && nearest.similarity >= 0.55) {
      const list = (proposedAliases[nearest.id] ??= []);
      for (const m of c.members) {
        if (!list.includes(m)) list.push(m);
        proposedCorpus.push({
          utterance: m,
          expect: { stepId: null, queryId: nearest.id },
        });
      }
      continue;
    }
    // Unmapped — corpus rows for ranker OOD / refuse training.
    for (const m of c.members) {
      proposedCorpus.push({ utterance: m, expect: { stepId: null } });
    }
  }

  return {
    note: 'Miss clusters → proposed FAQ/query aliases + ranker corpus. Human-review; fold via feedback fold / pack accept after meta.checked=true.',
    clusters,
    proposedFaqAliases,
    proposedAliases,
    proposedCorpus,
    singletonCount,
  };
}
