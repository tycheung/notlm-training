import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

export function walkSourceFiles(dir: string, exts: Set<string>): string[] {
  const out: string[] = [];
  walk(dir, exts, out);
  return out;
}

function walk(dir: string, exts: Set<string>, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, exts, out);
    } else if (st.isFile() && exts.has(extname(name).toLowerCase())) {
      out.push(full);
    }
  }
}

export function readRelative(root: string, file: string): { rel: string; text: string } {
  return {
    rel: relative(root, file).replace(/\\/g, '/'),
    text: readFileSync(file, 'utf8'),
  };
}
