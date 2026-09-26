import { describe, expect, it } from 'vitest';
import { createLabelerFromEnv, createMockLayaLabeler } from './layaLabeler.js';

describe('createMockLayaLabeler', () => {
  it('labels create list → create_list', async () => {
    const labeler = createMockLayaLabeler();
    const result = await labeler.labelCandidates({
      candidates: [{ id: 'c1', utterance: 'create a list' }],
      flowSteps: [{ id: 'create_list', keywords: ['list'] }],
      intents: { aliases: { create_list: ['create list', 'make a list'] } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scenarios[0]?.expect.stepId).toBe('create_list');
    }
  });

  it('createLabelerFromEnv respects mock', () => {
    const prev = process.env.UIPILOT_LABELER;
    process.env.UIPILOT_LABELER = 'mock';
    expect(createLabelerFromEnv()?.id).toBe('laya-mock');
    process.env.UIPILOT_LABELER = 'llm';
    expect(createLabelerFromEnv()).toBeUndefined();
    if (prev === undefined) delete process.env.UIPILOT_LABELER;
    else process.env.UIPILOT_LABELER = prev;
  });
});
