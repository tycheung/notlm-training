import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdInit } from './commands.js';
import { cmdTrainAuto, cmdTrainPause, cmdTrainStop } from './cmdTrainAuto.js';
import { pathExists, resolveNotlmHome } from './notlmHome.js';
import { isFatCommand } from './fatDispatch.js';

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

describe('train auto CLI', () => {
  it('routes fat train commands', () => {
    expect(isFatCommand('train', 'auto')).toBe(true);
    expect(isFatCommand('train', 'pause')).toBe(true);
    expect(isFatCommand('train', 'nope')).toBe(false);
  });

  it('fixture run fills rolling window and can meet a tiny bar', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-train-auto-'));
    temps.push(root);
    await cmdInit(root);
    const { home } = resolveNotlmHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });
    if (pathExists(join(fixtureHome, 'scenarios.json'))) {
      cpSync(join(fixtureHome, 'scenarios.json'), join(home, 'scenarios.json'));
    }

    await cmdTrainAuto([
      root,
      '--fixture',
      '--pass-rate=0.5',
      '--confidence=0.9',
      '--window=6',
      '--max-iterations=24',
    ]);

    expect(pathExists(join(home, 'train-auto', 'report.json'))).toBe(true);
    const report = JSON.parse(
      readFileSync(join(home, 'train-auto', 'report.json'), 'utf8')
    ) as { stoppedReason: string; rolling: { items: unknown[]; met: boolean } };
    expect(report.rolling.items.length).toBeGreaterThan(0);
    expect(['met', 'max-iterations', 'stop']).toContain(report.stoppedReason);
  }, 60_000);

  it('pause and stop write control file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-train-ctl-'));
    temps.push(root);
    await cmdInit(root);
    await cmdTrainPause([root]);
    const { home } = resolveNotlmHome(root);
    const ctl = JSON.parse(
      readFileSync(join(home, 'train-auto', 'control.json'), 'utf8')
    ) as { state: string };
    expect(ctl.state).toBe('paused');
    await cmdTrainStop([root]);
    const ctl2 = JSON.parse(
      readFileSync(join(home, 'train-auto', 'control.json'), 'utf8')
    ) as { state: string };
    expect(ctl2.state).toBe('stop');
  });
});
