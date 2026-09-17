import { parseUtterance, type IntentParsePack, type StepId } from '@uipilot/core';

export type ClashGroup = {
  id: string;
  /** Near-tied / overlapping step ids. */
  candidates: StepId[];
  /** Phrases that collide (aliases, keywords, or shared text). */
  triggerPhrases: string[];
};

function groupKey(candidates: StepId[]): string {
  return [...candidates].sort().join('|');
}

function pushPhrase(
  map: Map<string, { candidates: Set<StepId>; phrases: Set<string> }>,
  candidates: StepId[],
  phrase: string
): void {
  if (candidates.length < 2) return;
  const key = groupKey(candidates);
  let row = map.get(key);
  if (!row) {
    row = { candidates: new Set(candidates), phrases: new Set() };
    map.set(key, row);
  }
  for (const id of candidates) row.candidates.add(id);
  if (phrase.trim()) row.phrases.add(phrase.trim().toLowerCase());
}

/**
 * Detect muddy / clashing intents from pack aliases + keywords.
 * Used during authoring saturation to auto-split into context-tree modes.
 */
export function detectClashes(pack: IntentParsePack): ClashGroup[] {
  const byKey = new Map<string, { candidates: Set<StepId>; phrases: Set<string> }>();

  // Exact shared phrases across steps (alias / keyword / title).
  const owners = new Map<string, Set<StepId>>();
  for (const step of pack.steps) {
    const phrases = [
      step.title,
      ...step.keywords,
      ...(pack.aliases[step.id] ?? []),
    ];
    for (const raw of phrases) {
      const phrase = raw.trim().toLowerCase();
      if (!phrase) continue;
      let set = owners.get(phrase);
      if (!set) {
        set = new Set();
        owners.set(phrase, set);
      }
      set.add(step.id);
    }
  }
  for (const [phrase, steps] of owners) {
    if (steps.size >= 2) pushPhrase(byKey, [...steps], phrase);
  }

  // Runtime near-ties: parse each distinctive phrase.
  for (const step of pack.steps) {
    const phrases = [
      step.title,
      ...step.keywords,
      ...(pack.aliases[step.id] ?? []),
    ];
    for (const phrase of phrases) {
      const trimmed = phrase.trim();
      if (!trimmed || !trimmed.includes(' ')) continue;
      const parsed = parseUtterance(trimmed, pack);
      if (parsed.rawIntent === 'ambiguous' && parsed.candidates && parsed.candidates.length >= 2) {
        pushPhrase(byKey, parsed.candidates, trimmed);
      }
    }
  }

  const groups: ClashGroup[] = [];
  let i = 0;
  for (const row of byKey.values()) {
    i += 1;
    groups.push({
      id: `clash-${i}`,
      candidates: [...row.candidates].sort(),
      triggerPhrases: [...row.phrases].sort(),
    });
  }
  return groups.sort((a, b) => b.triggerPhrases.length - a.triggerPhrases.length);
}

export function clashDensity(pack: IntentParsePack): {
  groups: ClashGroup[];
  muddy: boolean;
  sharedPhraseCount: number;
} {
  const groups = detectClashes(pack);
  const sharedPhraseCount = groups.reduce((n, g) => n + g.triggerPhrases.length, 0);
  return {
    groups,
    muddy: groups.length > 0,
    sharedPhraseCount,
  };
}
