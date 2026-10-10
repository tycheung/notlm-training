import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeCustomSemanticFromClusters } from './customIndex.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('writeCustomSemanticFromClusters', () => {
  it('writes custom docs from nearest faq clusters', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'notlm-custom-'));
    dirs.push(packDir);
    const out = writeCustomSemanticFromClusters(packDir, [
      {
        centroid: 'is max 300 enforced for baker?',
        members: ['is max 300 enforced for baker?', 'baker max 300?'],
        nearest: { id: 'faq-max-300', kind: 'faq', similarity: 0.8 },
      },
    ]);
    expect(out.docsTotal).toBe(1);
    const idx = JSON.parse(readFileSync(out.path, 'utf8')) as {
      layer: string;
      docs: Array<{ id: string; texts: string[] }>;
    };
    expect(idx.layer).toBe('custom');
    expect(idx.docs[0]?.id).toBe('faq-max-300');
    expect(idx.docs[0]?.texts.length).toBeGreaterThan(0);
  });

  it('refuses to wipe a corrupt custom index', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'notlm-custom-bad-'));
    dirs.push(packDir);
    const path = join(packDir, 'semantic-index.custom.json');
    writeFileSync(path, '{not-json', 'utf8');
    expect(() =>
      writeCustomSemanticFromClusters(packDir, [
        {
          centroid: 'x',
          members: ['x'],
          nearest: { id: 'faq-a', kind: 'faq', similarity: 0.9 },
        },
      ])
    ).toThrow(/Corrupt/);
    expect(readFileSync(path, 'utf8')).toBe('{not-json');
  });
});
