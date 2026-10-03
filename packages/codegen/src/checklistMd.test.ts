import { describe, expect, it } from 'vitest';
import { checklistToMarkdown } from './checklistMd.js';

describe('checklistToMarkdown', () => {
  it('renders unchecked and checked items', () => {
    const md = checklistToMarkdown({
      items: [
        {
          id: 'annotate-1',
          kind: 'missing-guide-id',
          message: 'Add data-guide-id',
          proposedGuideId: 'guide-save',
          checked: false,
        },
        {
          id: 'done',
          kind: 'binders',
          message: 'Binders reviewed',
          checked: true,
        },
      ],
    });
    expect(md).toContain('# NotLM checklist');
    expect(md).toContain('- [ ] **missing-guide-id**: Add data-guide-id (`guide-save`)');
    expect(md).toContain('- [x] **binders**: Binders reviewed');
  });

  it('supports severity/text shape', () => {
    const md = checklistToMarkdown({
      items: [{ id: 'parity', severity: 'info', text: 'Compare corpus' }],
    });
    expect(md).toContain('**info**: Compare corpus');
  });

  it('handles empty checklist', () => {
    expect(checklistToMarkdown({ items: [] })).toContain('_No items._');
  });
});
