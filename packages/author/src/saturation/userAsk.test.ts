import { describe, expect, it } from 'vitest';
import { buildScenarioGeneratePrompt } from './generatePrompt.js';
import { faqDraftFromSoftLabels } from './softLabel.js';

describe('buildScenarioGeneratePrompt user-ask', () => {
  it('centers productBlurb and avoids DAG-primary framing', () => {
    const prompt = buildScenarioGeneratePrompt({
      batchSize: 10,
      flowSteps: [{ id: 'create_list' }],
      priorUtterances: [],
      productBlurb: 'A grocery list app for busy parents.',
      mode: 'user-ask',
    });
    expect(prompt).toMatch(/productBlurb/);
    expect(prompt).toMatch(/grocery list app for busy parents/);
    expect(prompt).toMatch(/Do NOT optimize for checklist/);
    expect(prompt).toMatch(/first-time user/);
  });
});

describe('faqDraftFromSoftLabels', () => {
  it('collapses faq expects into draft entries', () => {
    const draft = faqDraftFromSoftLabels([
      {
        id: '1',
        utterance: 'is this free',
        expect: { rawIntent: 'faq', faqId: 'pricing', answer: 'Yes, free demo.' },
      },
      {
        id: '2',
        utterance: 'does it cost money',
        expect: { faqId: 'pricing', answer: 'Yes, free demo.' },
      },
    ]);
    expect(draft).toHaveLength(1);
    expect(draft[0]?.id).toBe('pricing');
    expect(draft[0]?.aliases).toContain('is this free');
    expect(draft[0]?.aliases).toContain('does it cost money');
  });
});
