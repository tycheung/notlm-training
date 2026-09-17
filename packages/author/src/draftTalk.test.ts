import { describe, expect, it } from 'vitest';
import { draftConversationalCopy } from './draftTalk.js';

describe('draftConversationalCopy', () => {
  it('returns fixture banks without a provider', async () => {
    const result = await draftConversationalCopy({
      fixture: true,
      stepTitles: [{ id: 'create_list', title: 'Create list' }],
    });
    expect(result.ok).toBe(true);
    expect(result.replies?.launch?.length).toBeGreaterThan(0);
    expect(result.slotAsks?.create_list?.[0]?.ask).toMatch(/Create list/);
    expect(result.faq?.length).toBeGreaterThan(0);
  });
});
