import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runPipelinePost, wantsLaya } from './pipelinePost.js';

describe('wantsLaya', () => {
  it('reads --laya=1 / true / bare', () => {
    expect(wantsLaya(['--laya=1'])).toBe(true);
    expect(wantsLaya(['--laya=true'])).toBe(true);
    expect(wantsLaya(['--laya'])).toBe(true);
    expect(wantsLaya(['--laya=0'])).toBe(false);
    expect(wantsLaya([])).toBe(false);
  });
});

describe('runPipelinePost', () => {
  it('fails loud on corrupt corpus.json and skips laya', async () => {
    const root = join(tmpdir(), `notlm-pipe-${Date.now()}`);
    const home = join(root, '.notlm');
    const packDir = join(home, 'pack');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(
      join(packDir, 'manifest.json'),
      `${JSON.stringify({ id: 't' })}\n`,
      'utf8'
    );
    writeFileSync(join(packDir, 'corpus.json'), '{not-json', 'utf8');
    writeFileSync(
      join(packDir, 'flow.json'),
      `${JSON.stringify([])}\n`,
      'utf8'
    );
    writeFileSync(
      join(packDir, 'intents.json'),
      `${JSON.stringify({ aliases: {} })}\n`,
      'utf8'
    );
    writeFileSync(
      join(packDir, 'controls.json'),
      `${JSON.stringify([])}\n`,
      'utf8'
    );
    writeFileSync(
      join(packDir, 'faq.json'),
      `${JSON.stringify([])}\n`,
      'utf8'
    );
    writeFileSync(
      join(packDir, 'queries.json'),
      `${JSON.stringify([])}\n`,
      'utf8'
    );

    const prevExit = process.exitCode;
    process.exitCode = 0;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await runPipelinePost({
        home,
        packDir,
        projectRoot: root,
        skipEmbed: true,
        laya: true,
      });
      expect(result.ok).toBe(false);
      expect(result.ranker.reason).toMatch(/Invalid JSON|failed/i);
      expect(result.laya.ran).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = prevExit;
    }
  });
});
