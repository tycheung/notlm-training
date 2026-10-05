import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initNotlmHomeForTests } from './testInitNotlmHome.js';
import { cmdAuto } from './cmdAuto.js';
import { pathExists, resolveNotlmHome } from './notlmHome.js';
import { isFatCommand } from './fatDispatch.js';
import { runCli } from './cli.js';

const temps: string[] = [];
const fixturePack = join(process.cwd(), 'fixtures/minimal-pack/.notlm/pack');
const fixtureHome = join(process.cwd(), 'fixtures/minimal-pack/.notlm');

afterEach(() => {
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  process.exitCode = undefined;
});

describe('auto CLI (lane stress)', () => {
  it('train is handled by runCli, not fatDispatch', () => {
    expect(isFatCommand('train', 'auto')).toBe(false);
    expect(isFatCommand('ranker', 'train')).toBe(true);
    expect(isFatCommand('scenarios', 'saturate')).toBe(true);
  });

  it('fixture run writes train-auto report and seeds authoring artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-auto-'));
    temps.push(root);
    await initNotlmHomeForTests(root);
    const { home } = resolveNotlmHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });
    if (pathExists(join(fixtureHome, 'scenarios.json'))) {
      cpSync(join(fixtureHome, 'scenarios.json'), join(home, 'scenarios.json'));
    }

    await cmdAuto([
      root,
      '--fixture',
      '--per-lane=3',
      '--pass-rate=0.5',
      '--max-rounds=2',
      '--lanes=faq,goto',
    ]);

    expect(pathExists(join(home, 'train-auto', 'report.json'))).toBe(true);
    const report = JSON.parse(
      readFileSync(join(home, 'train-auto', 'report.json'), 'utf8')
    ) as {
      ok: boolean;
      stopReason: string;
      final: { total: number; passRate: number };
    };
    expect(report.final.total).toBeGreaterThan(0);
    expect(['no_failures', 'max_rounds', 'stalled']).toContain(
      report.stopReason
    );
    expect(pathExists(join(home, 'e2e-scenarios.json'))).toBe(true);
  }, 60_000);

  it('rejects removed auto pause subcommand via runCli', async () => {
    await runCli(['auto', 'pause', '.']);
    expect(process.exitCode).toBe(1);
  });
});
