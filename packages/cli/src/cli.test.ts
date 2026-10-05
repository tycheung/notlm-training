import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdDraft, cmdFold, cmdMetrics, cmdPull, runCli, takeFlag, usage } from './cli.js';

const sampleExchange = {
  text: 'make a tourney',
  kind: 'unknown',
  at: '2026-01-01T00:00:00.000Z',
  llmReply: 'Open Create tournament',
  proposed: { type: 'goto', stepId: 'create_tournament' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('takeFlag', () => {
  it('reads --name value and --name=value', () => {
    expect(takeFlag(['--url', 'https://x'], '--url')).toBe('https://x');
    expect(takeFlag(['--url=https://y'], '--url')).toBe('https://y');
    expect(takeFlag(['--other', 'z'], '--url')).toBeUndefined();
  });
});

describe('usage / runCli routing', () => {
  it('prints help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    usage();
    await runCli(['help']);
    await runCli(['--help']);
    await runCli([]);
    expect(log.mock.calls.some((c) => String(c[0]).includes('feedback pull'))).toBe(
      true
    );
  });

  it('rejects unknown commands', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runCli(['nope']);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/Unknown command/);
  });

  it('surfaces thrown errors as exitCode 1', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runCli(['exchanges', 'pull', '--url', 'https://example.invalid']);
    // fetch will fail (network or our stub) — ensure catch path works via stub:
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    process.exitCode = undefined;
    await runCli(['exchanges', 'pull', '--url', 'https://x']);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.at(-1)?.[0]).toBe('boom');
  });
});

describe('cmdPull', () => {
  it('requires --url', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdPull([]);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/--url/);
  });

  it('writes validated exchanges to --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-train-pull-'));
    const out = join(dir, 'ex.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => [sampleExchange],
      }))
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdPull(['--url', 'https://api.example/misses', '--out', out]);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toHaveLength(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/Wrote 1 exchanges/);
  });

  it('prints to stdout when --out omitted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => [sampleExchange],
      }))
    );
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await cmdPull(['--url=https://api.example/misses']);
    expect(String(write.mock.calls[0]?.[0])).toContain('make a tourney');
  });

  it('filters array rows with llmReply when schema rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        // Missing llmReply on one row → list schema fails; filter keeps portable exchanges.
        json: async () => [
          { text: 'miss-only', kind: 'unknown', at: 't' },
          sampleExchange,
        ],
      }))
    );
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await cmdPull(['--url', 'https://api.example/misses']);
    const body = JSON.parse(String(write.mock.calls[0]?.[0]));
    expect(body).toHaveLength(1);
    expect(body[0].text).toBe('make a tourney');
  });

  it('throws on HTTP failure and non-array schema failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Nope',
        json: async () => ({}),
      }))
    );
    await expect(cmdPull(['--url', 'https://x'])).rejects.toThrow(/HTTP 500/);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ not: 'array' }),
      }))
    );
    await expect(cmdPull(['--url', 'https://x'])).rejects.toThrow();
  });
});

describe('cmdDraft', () => {
  it('requires --from', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdDraft([]);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/--from/);
  });

  it('writes draft under .notlm/drafts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-train-draft-'));
    const from = join(dir, 'ex.json');
    writeFileSync(from, JSON.stringify([sampleExchange]), 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdDraft(['--from', from, dir]);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/Exchange draft/);
    expect(existsSync(join(dir, '.notlm'))).toBe(true);
  });

  it('accepts --from= form', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-train-draft2-'));
    const from = join(dir, 'ex.jsonl');
    writeFileSync(from, `${JSON.stringify(sampleExchange)}\n`, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdDraft([`--from=${from}`, dir]);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/1 records/);
  });
});

describe('cmdFold', () => {
  it('requires --from', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cmdFold } = await import('./cli.js');
    await cmdFold([]);
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/--from/);
  });

  it('writes pack-accept draft from exchange draft.json', async () => {
    const { cmdFold } = await import('./cli.js');
    const dir = mkdtempSync(join(tmpdir(), 'notlm-train-fold-'));
    const home = join(dir, '.notlm');
    mkdirSync(join(home, 'pack'), { recursive: true });
    writeFileSync(
      join(home, 'pack', 'intents.json'),
      JSON.stringify({ aliases: { create_tournament: ['create tournament'] } }),
      'utf8'
    );
    const exPath = join(dir, 'ex.json');
    writeFileSync(exPath, JSON.stringify([sampleExchange]), 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdDraft(['--from', exPath, dir]);
    const draftLine = String(log.mock.calls[0]?.[0]);
    const m = draftLine.match(/Exchange draft → (.+?) \(/);
    expect(m?.[1]).toBeTruthy();
    const draftJson = join(m![1]!, 'draft.json');
    log.mockClear();
    await cmdFold(['--from', draftJson, dir]);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/Folded pack draft/);
  });
});

describe('cmdMetrics', () => {
  it('requires --from', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdMetrics([]);
    expect(process.exitCode).toBe(1);
  });

  it('prints metrics with optional misses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-train-met-'));
    const ex = join(dir, 'ex.json');
    const misses = join(dir, 'misses.json');
    writeFileSync(ex, JSON.stringify([sampleExchange]), 'utf8');
    writeFileSync(
      misses,
      JSON.stringify([
        { text: 'a', kind: 'unknown', at: 't' },
        { text: 'b', kind: 'unknown', at: 't' },
      ]),
      'utf8'
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdMetrics(['--from', ex, '--misses', misses]);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(parsed.exchangeCount).toBe(1);
    expect(parsed.missCount).toBe(2);
    expect(parsed.fallbackShare).toBe(0.5);
  });
});
