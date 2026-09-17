import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdAnnotateChecklist, cmdInit, cmdDagGenerate } from './commands.js';
import { cmdMap, cmdTune } from './cmdMapTunePrepare.js';
import { cmdScenariosGenerate, cmdScenariosSaturate } from './cmdScenarios.js';
import { cmdScenariosAsk, cmdScenariosLabelPool } from './cmdScenariosAsk.js';
import { pathExists, resolveUipilotHome } from './uipilotHome.js';
import { cmdRankerTrain } from './cmdRanker.js';

const temps: string[] = [];
const fixturePack = join(process.cwd(), 'fixtures/minimal-pack/.uipilot/pack');
const fixtureHome = join(process.cwd(), 'fixtures/minimal-pack/.uipilot');

afterEach(() => {
  for (const t of temps.splice(0)) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('scenarios saturate (fixture)', () => {
  it('writes candidates + novelty report without LLM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uipilot-sat-'));
    temps.push(root);
    await cmdInit(root);
    const { home } = resolveUipilotHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });
    if (pathExists(join(fixtureHome, 'scenarios.json'))) {
      cpSync(join(fixtureHome, 'scenarios.json'), join(home, 'scenarios.json'));
    }

    await cmdScenariosGenerate([root, '--batch', '4', '--fixture']);
    expect(pathExists(join(home, 'saturation', 'candidates.json'))).toBe(true);
    expect(pathExists(join(home, 'saturation', 'novelty-report.json'))).toBe(true);

    await cmdScenariosSaturate([
      root,
      '--fixture',
      '--batch',
      '3',
      '--max-batches',
      '4',
      '--label',
    ]);
    const report = JSON.parse(
      readFileSync(join(home, 'saturation', 'novelty-report.json'), 'utf8')
    ) as { plateau?: boolean; batches?: unknown[] };
    expect(Array.isArray(report.batches)).toBe(true);
    expect(report.batches!.length).toBeGreaterThanOrEqual(1);
  });
});

describe('map / tune façade', () => {
  it('map writes structured-draft without LLM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uipilot-map-'));
    temps.push(root);
    await cmdInit(root);
    const { home } = resolveUipilotHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });
    if (pathExists(join(fixtureHome, 'scenarios.json'))) {
      cpSync(join(fixtureHome, 'scenarios.json'), join(home, 'scenarios.json'));
    }
    await cmdMap([root]);
    expect(pathExists(join(home, 'structured-draft.json'))).toBe(true);
  });

  it('tune with --fixture saturates without LLM provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uipilot-tune-'));
    temps.push(root);
    await cmdInit(root);
    const { home } = resolveUipilotHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });
    if (pathExists(join(fixtureHome, 'scenarios.json'))) {
      cpSync(join(fixtureHome, 'scenarios.json'), join(home, 'scenarios.json'));
    }
    await cmdDagGenerate(root);
    await cmdTune([root, '--fixture', '--batch=3']);
    expect(pathExists(join(home, 'saturation', 'candidates.json'))).toBe(true);
  });

  it('tune --force=N hard-adds exactly N ignoring novelty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uipilot-force-'));
    temps.push(root);
    await cmdInit(root);
    const { home } = resolveUipilotHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });
    if (pathExists(join(fixtureHome, 'scenarios.json'))) {
      cpSync(join(fixtureHome, 'scenarios.json'), join(home, 'scenarios.json'));
    }
    await cmdTune([root, '--fixture', '--force=12']);
    const data = JSON.parse(
      readFileSync(join(home, 'saturation', 'candidates.json'), 'utf8')
    ) as { candidates: unknown[] };
    const report = JSON.parse(
      readFileSync(join(home, 'saturation', 'novelty-report.json'), 'utf8')
    ) as { stopReason?: string; forcedCount?: number };
    expect(data.candidates.length).toBe(12);
    expect(report.stopReason).toBe('force');
    expect(report.forcedCount).toBe(12);
  });
});

describe('annotate checklist', () => {
  it('merges host annotation DoD items idempotently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uipilot-ann-'));
    temps.push(root);
    await cmdInit(root);
    const { home } = resolveUipilotHome(root);
    await cmdAnnotateChecklist([root]);
    await cmdAnnotateChecklist([root]);
    const data = JSON.parse(readFileSync(join(home, 'checklist.json'), 'utf8')) as {
      items: Array<{ id: string }>;
    };
    const ids = data.items.map((i) => i.id);
    expect(ids.filter((id) => id === 'annotate-guide-ids')).toHaveLength(1);
    expect(ids).toContain('annotate-notify-complete');
  });
});

describe('ranker train CLI', () => {
  it('writes pack/ranker.json from corpus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uipilot-rank-'));
    temps.push(root);
    await cmdInit(root);
    const { home } = resolveUipilotHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });
    if (pathExists(join(fixtureHome, 'scenarios.json'))) {
      cpSync(join(fixtureHome, 'scenarios.json'), join(home, 'scenarios.json'));
    }
    const { cmdRankerTrain } = await import('./cmdRanker.js');
    await cmdRankerTrain([root, '--epochs=20', '--dim=64']);
    expect(pathExists(join(home, 'pack', 'ranker.json'))).toBe(true);
  });
});

describe('scenarios ask (user-ask blurb pool)', () => {
  it('hard-augments user-ask fixture pool and label-pool drafts scenarios', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uipilot-ask-'));
    temps.push(root);
    await cmdInit(root);
    const { home } = resolveUipilotHome(root);
    cpSync(fixturePack, join(home, 'pack'), { recursive: true });
    if (pathExists(join(fixtureHome, 'scenarios.json'))) {
      cpSync(join(fixtureHome, 'scenarios.json'), join(home, 'scenarios.json'));
    }

    await cmdScenariosAsk([
      root,
      '--fixture',
      '--force=12',
      '--blurb=Tiny grocery list demo',
      '--label-pool',
    ]);
    expect(pathExists(join(home, 'saturation', 'candidates.json'))).toBe(true);
    const pool = JSON.parse(
      readFileSync(join(home, 'saturation', 'candidates.json'), 'utf8')
    ) as { candidates: unknown[] };
    expect(pool.candidates.length).toBe(12);

    // label-pool already ran via --label-pool; ensure a soft-label-pool draft exists
    const drafts = join(home, 'drafts');
    expect(pathExists(drafts)).toBe(true);
  });
});
