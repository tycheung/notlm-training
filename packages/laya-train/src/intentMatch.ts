export function aliasesMap(intents: unknown): Record<string, string[]> {
  if (!intents || typeof intents !== 'object') return {};
  const aliases = (intents as { aliases?: Record<string, string[]> }).aliases;
  if (!aliases || typeof aliases !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(aliases)) {
    if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string');
  }
  return out;
}

export function scoreStep(
  utterance: string,
  stepId: string,
  aliases: string[],
  keywords: string[]
): number {
  const u = utterance.toLowerCase();
  let best = 0;
  for (const a of [...aliases, ...keywords, stepId.replace(/_/g, ' ')]) {
    const needle = a.toLowerCase();
    if (!needle) continue;
    if (u === needle) best = Math.max(best, 1);
    else if (u.includes(needle)) best = Math.max(best, 0.85);
  }
  return best;
}
