import { describe, expect, it } from 'vitest';
import { e2eScenariosFromFlow } from './e2eScenarios.js';
import { glossaryStubsFromControls } from './glossaryCrawl.js';

describe('e2eScenariosFromFlow', () => {
  it('builds happy-path stubs from flow steps', () => {
    const out = e2eScenariosFromFlow([
      {
        id: 'a',
        title: 'A',
        keywords: ['a'],
        kind: 'hard',
        requires: [],
      },
      {
        id: 'b',
        title: 'B',
        keywords: ['b'],
        kind: 'soft',
        requires: ['a'],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]?.expect.requiresChain).toEqual(['a']);
    expect(out[0]?.utterance).toContain('open');
  });
});

describe('glossaryStubsFromControls', () => {
  it('emits glossary stubs for controls with coach copy', () => {
    const stubs = glossaryStubsFromControls([
      {
        id: 'c1',
        stepId: 'a',
        label: 'Name field',
      },
      {
        id: 'c1',
        stepId: 'a',
        label: 'duplicate skipped',
      },
      {
        guideId: 'g2',
        title: 'Save',
      },
    ]);
    expect(stubs).toHaveLength(2);
    expect(stubs[0]?.aliases[0]).toBe('name field');
    expect(stubs[1]?.guideId).toBe('g2');
  });
});
