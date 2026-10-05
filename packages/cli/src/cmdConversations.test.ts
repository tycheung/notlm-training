import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdConversationsAnalyze,
  cmdConversationsPull,
} from './cmdConversations.js';
import { initNotlmHomeForTests } from './testInitNotlmHome.js';
import { pathExists, resolveNotlmHome } from './notlmHome.js';
import { runCli } from './cli.js';

const fixturePack = join(process.cwd(), 'fixtures/minimal-pack/.notlm/pack');

const sampleTurn = {
  conversationId: 'c1',
  turnId: 't1',
  at: '2026-01-01T00:00:00.000Z',
  role: 'user' as const,
  text: 'please spawn a list',
  outcome: 'hit' as const,
  stepId: 'create_list',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('cmdConversationsPull', () => {
  it('requires --url', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdConversationsPull([]);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/--url/);
  });

  it('writes aggregated conversations from turn dump', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-conv-pull-'));
    const out = join(dir, 'conv.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => [sampleTurn],
      }))
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdConversationsPull(['--url', 'https://api.example/conv', '--out', out]);
    expect(existsSync(out)).toBe(true);
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as Array<{
      conversationId: string;
      turns: unknown[];
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.conversationId).toBe('c1');
    expect(parsed[0]?.turns).toHaveLength(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/Wrote 1 conversations/);
  });
});

describe('cmdConversationsAnalyze', () => {
  it('requires --from', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdConversationsAnalyze([]);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/--from/);
  });

  it('fixture review mode writes unchecked fold draft', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-conv-review-'));
    await initNotlmHomeForTests(root);
    const { home } = resolveNotlmHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });

    const from = join(root, 'conv.json');
    writeFileSync(
      from,
      JSON.stringify([
        {
          conversationId: 'c1',
          startedAt: '2026-01-01T00:00:00.000Z',
          turns: [
            sampleTurn,
            {
              conversationId: 'c1',
              turnId: 't2',
              at: '2026-01-01T00:00:01.000Z',
              role: 'assistant',
              text: 'Opening…',
            },
            {
              conversationId: 'c1',
              turnId: 't3',
              at: '2026-01-01T00:00:02.000Z',
              role: 'user',
              text: 'zzz',
              outcome: 'miss',
              missKind: 'unknown',
            },
            {
              conversationId: 'c1',
              turnId: 't4',
              at: '2026-01-01T00:00:03.000Z',
              role: 'assistant',
              text: 'Did not catch that',
            },
          ],
        },
      ]),
      'utf8'
    );

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdConversationsAnalyze(['--from', from, root, '--mode=review', '--fixture']);
    expect(process.exitCode ?? 0).toBe(0);

    const drafts = join(home, 'drafts');
    expect(pathExists(drafts)).toBe(true);
    const foldDirs = readdirSync(drafts).filter((d) => d.startsWith('conversations-fold-'));
    expect(foldDirs.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(
      readFileSync(join(drafts, foldDirs[0]!, 'meta.json'), 'utf8')
    ) as { checked: boolean; kind: string };
    expect(meta.kind).toBe('conversations-fold');
    expect(meta.checked).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes('mode=review'))).toBe(true);
  });

  it('fixture auto mode accepts into pack', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-conv-auto-'));
    await initNotlmHomeForTests(root);
    const { home } = resolveNotlmHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });

    const from = join(root, 'conv.json');
    writeFileSync(
      from,
      JSON.stringify([
        {
          conversationId: 'c1',
          startedAt: '2026-01-01T00:00:00.000Z',
          turns: [sampleTurn],
        },
      ]),
      'utf8'
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdConversationsAnalyze(['--from', from, root, '--mode=auto', '--fixture']);
    expect(process.exitCode ?? 0).toBe(0);

    const intents = JSON.parse(
      readFileSync(join(home, 'pack', 'intents.json'), 'utf8')
    ) as { aliases?: Record<string, string[]> };
    expect(intents.aliases?.create_list).toContain('please spawn a list');
  });
});

describe('runCli conversations routing', () => {
  it('mentions conversations in help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['help']);
    expect(log.mock.calls.some((c) => String(c[0]).includes('feedback conversations'))).toBe(
      true
    );
  });
});
