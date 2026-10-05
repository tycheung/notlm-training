/** Shared CLI flag helpers for notlm-training. */

export function takeFlag(args: string[], name: string): string | undefined {
  const eq = args.findIndex((a) => a.startsWith(`${name}=`));
  if (eq >= 0) return args[eq]!.slice(name.length + 1);
  const idx = args.findIndex((a) => a === name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
}

/** First non-flag positional that is not a bare number. */
export function positionalDir(args: string[]): string | undefined {
  for (const a of args) {
    if (a.startsWith('--')) continue;
    if (/^\d+(\.\d+)?$/.test(a)) continue;
    return a;
  }
  return undefined;
}
