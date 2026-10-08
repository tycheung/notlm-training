import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdE2eAuto } from './cmdE2eAuto.js';
import { pathExists, resolveNotlmHome } from './notlmHome.js';
import { isFatCommand } from './fatDispatch.js';
import { runCli } from './cli.js';

const temps: string[] = [];
const fixtureHome = join(process.cwd(), 'fixtures/e2eauto-pack/.notlm');

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

describe('e2eauto CLI', () => {
  it('is a top-level training mode, not fatDispatch', () => {
    expect(isFatCommand('e2eauto', undefined)).toBe(false);
  });

  it('fixture once-pass learns Max 300 alias and writes train-e2eauto', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-e2eauto-'));
    temps.push(root);
    const { home } = resolveNotlmHome(root);
    cpSync(fixtureHome, home, { recursive: true });

    await cmdE2eAuto([
      root,
      '--fixture',
      '--once',
      '--max-rounds=30',
      '--max-lessons=5',
      '--sources=faq-scenarios.json',
    ]);

    expect(pathExists(join(home, 'train-e2eauto', 'report.json'))).toBe(true);
    const report = JSON.parse(
      readFileSync(join(home, 'train-e2eauto', 'report.json'), 'utf8')
    ) as {
      lessons: number;
      gradeCounts: Record<string, number>;
      stopReason: string;
    };
    expect(report.lessons).toBeGreaterThanOrEqual(1);
    expect(pathExists(join(home, 'train-e2eauto', 'checkpoint'))).toBe(true);
  }, 60_000);

  it('runCli routes e2eauto', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-e2eauto-cli-'));
    temps.push(root);
    const { home } = resolveNotlmHome(root);
    cpSync(fixtureHome, home, { recursive: true });
    await runCli([
      'e2eauto',
      root,
      '--fixture',
      '--once',
      '--max-rounds=5',
      '--max-lessons=2',
      '--sources=faq-scenarios.json',
    ]);
    expect(pathExists(join(home, 'train-e2eauto', 'report.json'))).toBe(true);
  }, 60_000);
});
