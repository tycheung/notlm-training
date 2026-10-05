import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd());

function collectTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'dist' || name === 'node_modules') continue;
      collectTsFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:from\s+|import\s*\(\s*|export\s+\*\s+from\s+)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    specs.push(m[1]!);
  }
  return specs;
}

describe('training architecture', () => {
  it('must not import @notlm/react (runtime UI stays in operating repo)', () => {
    const hits: string[] = [];
    for (const file of collectTsFiles(join(ROOT, 'packages'))) {
      const text = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(text)) {
        if (spec === '@notlm/react' || spec.startsWith('@notlm/react/')) {
          hits.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('ships training package dirs', () => {
    const names = readdirSync(join(ROOT, 'packages'));
    for (const need of [
      'author',
      'mapper',
      'codegen',
      'llm',
      'recalibrate',
      'cli',
      'ranker-train',
      'laya-train',
    ]) {
      expect(names).toContain(need);
    }
  });
});
