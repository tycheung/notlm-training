import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ScenarioCase } from '@notlm/core';
import {
  bipartitionLabels,
  writeMultiStageRankers,
} from './trainMultiStage.js';

describe('trainMultiStage', () => {
  it('bipartitionLabels splits evenly', () => {
    const { a, b } = bipartitionLabels(['c', 'a', 'b', 'd']);
    expect(a.length).toBe(2);
    expect(b.length).toBe(2);
  });

  it('writeMultiStageRankers writes plane/lane/leaf + patches routingTree.leaves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-mst-'));
    const corpus: ScenarioCase[] = [
      { utterance: 'how do lists work?', expect: { faqId: 'lists' } },
      { utterance: 'open the checklist', expect: { stepId: 'open_checklist' } },
      { utterance: 'go to create item', expect: { stepId: 'create_item' } },
      { utterance: 'what is a project?', expect: { faqId: 'project' } },
      { utterance: 'delete this record', expect: { rawIntent: 'mutation' } },
      { utterance: 'show me the tour', expect: { rawIntent: 'tour' } },
    ];
    const r = writeMultiStageRankers({
      packDir: dir,
      corpus,
      aliases: {
        open_checklist: ['open pots', 'checklist desk'],
        create_item: ['new item'],
      },
      maxLeafLabels: 100,
      epochs: 8,
      dim: 32,
    });
    expect(existsSync(r.planePath)).toBe(true);
    expect(existsSync(r.lanePath)).toBe(true);
    expect(existsSync(r.flatPath)).toBe(true);
    expect(r.leafPaths.length).toBeGreaterThan(0);
    const plane = JSON.parse(readFileSync(r.planePath, 'utf8')) as {
      intentLabels: string[];
    };
    expect(plane.intentLabels).toEqual(
      expect.arrayContaining(['ask', 'guide', 'do'])
    );
    const treePath = join(dir, 'routingTree.json');
    expect(existsSync(treePath)).toBe(true);
    const tree = JSON.parse(readFileSync(treePath, 'utf8')) as {
      leaves: Record<string, string>;
    };
    expect(tree.leaves).toBeTruthy();
    for (const [lane, stem] of Object.entries(tree.leaves)) {
      const path = join(dir, `${stem}.json`);
      expect(existsSync(path), `missing leaf for ${lane}: ${path}`).toBe(true);
    }
  });
});
