/** Shared CLI flag helpers for notlm-training. */

export function takeFlag(args: string[], name: string): string | undefined {
  const eq = args.findIndex((a) => a.startsWith(`${name}=`));
  if (eq >= 0) return args[eq]!.slice(name.length + 1);
  const idx = args.findIndex((a) => a === name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

/** Same as {@link takeFlag}; name used by scenario/ranker commands. */
export const parseFlag = takeFlag;

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name) || args.some((a) => a.startsWith(`${name}=`));
}

const SCENARIO_VALUE_FLAGS = new Set([
  '--batch',
  '--max-batches',
  '--epsilon',
  '--force',
  '--hard',
  '--blurb',
  '--mode',
  '--chunk',
]);

/** Flags that take a following path/value in feedback/misses commands. */
export const FEEDBACK_PATH_FLAGS = new Set(['--from', '--out', '--url']);

/**
 * First non-flag positional.
 * Default: skip scenario value-flag pairs and bare integers (npm strips flag names).
 * Pass an explicit `valueFlags` set for other commands (no bare-integer skip).
 */
export function positionalDir(
  args: string[],
  valueFlags?: Set<string>
): string | undefined {
  const flags = valueFlags ?? SCENARIO_VALUE_FLAGS;
  const skipBareIntegers = valueFlags === undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (flags.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('--')) continue;
    if (skipBareIntegers && /^\d+$/.test(a)) continue;
    return a;
  }
  return undefined;
}

/** First token that does not start with `-` (no value-flag pairing). */
export function positionalDirFirst(args: string[]): string | undefined {
  for (const a of args) {
    if (a.startsWith('-')) continue;
    return a;
  }
  return undefined;
}
