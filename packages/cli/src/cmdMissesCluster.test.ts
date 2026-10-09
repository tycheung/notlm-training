import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdMissesCluster, cmdPackEmbedIndex } from './cmdMisses.js';

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

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'notlm-cluster-'));
  dirs.push(root);
  const home = join(root, '.notlm');
  mkdirSync(join(home, 'pack'), { recursive: true });
  writeFileSync(
    join(home, 'pack', 'faq.json'),
    JSON.stringify([
      {
        id: 'faq-max-300',
        aliases: ['is max 300 enforced'],
        text: 'Max 300 caps scores.',
      },
    ]),
    'utf8'
  );
  writeFileSync(
    join(home, 'pack', 'queries.json'),
    JSON.stringify({
      queries: [
        {
          id: 'td.next',
          title: 'Next',
          aliases: ['next tournament'],
        },
      ],
    }),
    'utf8'
  );
  writeFileSync(join(home, 'pack', 'flow.json'), '[]', 'utf8');
  return root;
}

describe('misses cluster + pack embed-index', () => {
  it('clusters misses into a draft folder', async () => {
    const root = makeHome();
    const misses = join(root, 'misses.json');
    writeFileSync(
      misses,
      JSON.stringify([
        { text: 'is max 300 enforced?', kind: 'unknown', at: 't' },
        { text: 'is max 300 enforced for baker?', kind: 'unknown', at: 't' },
      ]),
      'utf8'
    );
    await cmdMissesCluster(['--from', misses, root]);
    const drafts = join(root, '.notlm', 'drafts');
    const { readdirSync } = await import('node:fs');
    const folders = readdirSync(drafts).filter((n) => n.startsWith('misses-cluster-'));
    expect(folders.length).toBe(1);
    const draft = JSON.parse(
      readFileSync(join(drafts, folders[0]!, 'draft.json'), 'utf8')
    ) as { clusters: unknown[] };
    expect(draft.clusters.length).toBeGreaterThan(0);
  });

  it('writes semantic-index.json', async () => {
    const root = makeHome();
    await cmdPackEmbedIndex([root]);
    const idxPath = join(root, '.notlm', 'pack', 'semantic-index.json');
    const idx = JSON.parse(readFileSync(idxPath, 'utf8')) as {
      docs: unknown[];
      dim: number;
    };
    expect(idx.docs.length).toBeGreaterThan(0);
    expect(idx.dim).toBe(256);
  });
});
