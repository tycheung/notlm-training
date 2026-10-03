import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdMissesDraftAliases,
  cmdMissesExport,
  cmdMissesPull,
} from './cmdMisses.js';

describe('misses CLI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exports JSON array from JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-miss-'));
    try {
      const src = join(dir, 'misses.jsonl');
      writeFileSync(
        src,
        `${JSON.stringify({ text: 'a', kind: 'unknown', at: 't1' })}\n${JSON.stringify({ text: 'b', kind: 'ambiguous', at: 't2' })}\n`,
        'utf8'
      );
      const out = join(dir, 'out.json');
      await cmdMissesExport(['--from', src, '--out', out]);
      const parsed = JSON.parse(readFileSync(out, 'utf8')) as Array<{ text: string }>;
      expect(parsed.map((r) => r.text)).toEqual(['a', 'b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('export rejects snake_case host dumps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-miss-bad-'));
    try {
      const src = join(dir, 'bad.json');
      writeFileSync(
        src,
        JSON.stringify([{ utterance: 'nope', kind: 'unknown', at: 't' }]),
        'utf8'
      );
      await expect(cmdMissesExport(['--from', src])).rejects.toThrow(/snake_case/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pull fetches and writes portable MissRecord[]', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-miss-pull-'));
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify([
                {
                  text: 'pulled',
                  kind: 'unknown',
                  at: 't',
                  id: 1,
                  userId: 2,
                },
              ]),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        )
      );
      const out = join(dir, 'pulled.json');
      await cmdMissesPull(['--url', 'https://example.test/misses', '--out', out]);
      const parsed = JSON.parse(readFileSync(out, 'utf8')) as Array<{ text: string }>;
      expect(parsed).toEqual([{ text: 'pulled', kind: 'unknown', at: 't' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('draft-aliases writes grouped draft under .notlm/drafts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-miss-home-'));
    try {
      writeFileSync(join(dir, 'config.json'), '{}\n');
      const home = join(dir, '.notlm');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(home, 'drafts'), { recursive: true });
      writeFileSync(join(home, 'config.json'), '{}\n');

      const src = join(dir, 'misses.json');
      writeFileSync(
        src,
        JSON.stringify([
          { text: 'xyzzy', kind: 'unknown', at: 't' },
          { text: 'xyzzy', kind: 'unknown', at: 't2' },
          { text: 'huh', kind: 'ambiguous', at: 't3' },
        ]),
        'utf8'
      );
      await cmdMissesDraftAliases(['--from', src, dir]);
      const drafts = join(home, 'drafts');
      const { readdirSync } = await import('node:fs');
      const folders = readdirSync(drafts).filter((n) => n.startsWith('misses-'));
      expect(folders.length).toBe(1);
      const draft = JSON.parse(
        readFileSync(join(drafts, folders[0]!, 'draft.json'), 'utf8')
      ) as { byKind: Record<string, string[]> };
      expect(draft.byKind.unknown).toEqual(['xyzzy']);
      expect(draft.byKind.ambiguous).toEqual(['huh']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
