import { describe, expect, it } from 'vitest';
import {
  confusionFromEvalRows,
  proposeAutosplit,
} from './autosplit.js';

describe('autosplit', () => {
  it('proposes split on confident FP overlap', () => {
    const pairs = confusionFromEvalRows([
      ...Array.from({ length: 6 }, () => ({
        expected: 'goto:side_actions',
        predicted: 'goto:create_event',
        confidence: 0.9,
      })),
      {
        expected: 'faq',
        predicted: 'goto:side_actions',
        confidence: 0.5,
      },
    ]);
    const plan = proposeAutosplit(pairs, [
      'goto:side_actions',
      'goto:create_event',
      'faq',
      'unknown',
    ]);
    expect(plan).not.toBeNull();
    expect(plan!.labelsA).toContain('goto:side_actions');
    expect(plan!.labelsB).toContain('goto:create_event');
  });

  it('returns null below support threshold', () => {
    const plan = proposeAutosplit(
      [{ expected: 'a', predicted: 'b', count: 1, meanConfidence: 0.99 }],
      ['a', 'b'],
      { minSupport: 4 }
    );
    expect(plan).toBeNull();
  });

  it('proposeSizeAutosplit splits oversized label sets', async () => {
    const { proposeSizeAutosplit } = await import('./autosplit.js');
    const labels = Array.from({ length: 60 }, (_, i) => `goto:step_${i}`);
    const plan = proposeSizeAutosplit(labels, 'goto', { maxLabels: 48 });
    expect(plan).not.toBeNull();
    expect(plan!.childA).toBe('goto__a');
    expect(plan!.childB).toBe('goto__b');
    expect(plan!.labelsA.length + plan!.labelsB.length).toBe(60);
  });
});
