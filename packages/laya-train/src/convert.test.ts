import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { convertUipilotToLaya, buildRecordsForRows } from './convert.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/minimal-pack'
);

describe('convertUipilotToLaya', () => {
  it('writes JSONL + manifest from minimal-pack fixture', () => {
    const out = mkdtempSync(join(tmpdir(), 'laya-out-'));
    const { manifest, records } = convertUipilotToLaya(fixtureRoot, {
      mode: 'full',
      out,
    });
    expect(manifest.rows).toBeGreaterThan(0);
    expect(records.length).toBe(manifest.rows);
    expect(records[0]?.state).toBeTruthy();
    expect(records[0]?.questions.is_ood.type).toBe('noul');
    expect(records[0]?.answers.step.choice).toBeTruthy();

    const line = readFileSync(join(out, 'train.jsonl'), 'utf8').trim().split('\n')[0]!;
    const parsed = JSON.parse(line) as { answers: { step: { choice: string } } };
    expect(parsed.answers.step.choice).toBe(records[0]!.answers.step.choice);

    const manifestDisk = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
      rows: number;
    };
    expect(manifestDisk.rows).toBe(manifest.rows);
  });

  it('maps OOD utterance to refuse + is_ood=1', () => {
    const flow = [
      { id: 'create_list', keywords: ['list'] },
      { id: 'add_item', keywords: ['add'] },
    ];
    const intents = { aliases: { create_list: ['create list'] } };
    const [row] = buildRecordsForRows(
      [{ utterance: "what's the weather", expect: { stepId: null }, source: 'corpus' }],
      'light',
      flow,
      intents,
      [],
      'a todo app guide'
    );
    expect(row!.answers.step.choice).toBe('refuse');
    expect(row!.answers.is_ood.noul).toBe(1);
    expect(row!.answers.faq.choice).toBe('none');
    expect(Object.keys(row!.questions.step.criteria).length).toBeLessThan(4);
  });

  it('light mode shortlists step criteria', () => {
    const flow = [
      { id: 'create_list', keywords: ['list'] },
      { id: 'add_item', keywords: ['add'] },
      { id: 'complete_item', keywords: ['done'] },
    ];
    const intents = {
      aliases: {
        create_list: ['create list'],
        add_item: ['add item'],
        complete_item: ['mark done'],
      },
    };
    const [row] = buildRecordsForRows(
      [{ utterance: 'create a list', expect: { stepId: 'create_list' }, source: 'scenarios' }],
      'light',
      flow,
      intents,
      [],
      'guide'
    );
    const keys = Object.keys(row!.questions.step.criteria);
    expect(keys).toContain('create_list');
    expect(keys).toContain('refuse');
    expect(keys.length).toBeLessThan(5);
  });
});
