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

  it('writeMultiStageRankers writes plane/lane/leaf + flat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notlm-mst-'));
    const corpus: ScenarioCase[] = [
      { utterance: 'how do brackets work?', expect: { faqId: 'brackets' } },
      { utterance: 'open side actions', expect: { stepId: 'side_actions' } },
      { utterance: 'go to create event', expect: { stepId: 'create_event' } },
      { utterance: 'what is a squad?', expect: { faqId: 'squad' } },
      { utterance: 'delete this event', expect: { rawIntent: 'mutation' } },
      { utterance: 'show me the tour', expect: { rawIntent: 'tour' } },
    ];
    const r = writeMultiStageRankers({
      packDir: dir,
      corpus,
      aliases: {
        side_actions: ['open pots', 'side action desk'],
        create_event: ['new event'],
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
  });
});
