import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdInventoryAttach } from './cmdInventory.js';

describe('inventory attach', () => {
  it('writes drafts/controls-nav.json from control-map', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notlm-attach-'));
    const home = join(root, '.notlm');
    mkdirSync(join(home, 'pack'), { recursive: true });
    writeFileSync(
      join(home, 'inventory.json'),
      JSON.stringify({
        capturedAt: '2026-01-01T00:00:00.000Z',
        baseUrl: '',
        controls: [
          {
            role: 'button',
            name: 'Add',
            selectorHint: 'button',
            existingGuideId: 'guide-add',
            proposedGuideId: 'guide-add',
            url: '/',
          },
        ],
      })
    );
    writeFileSync(
      join(home, 'control-map.json'),
      JSON.stringify({ 'guide-add': 'add_contact' })
    );
    await cmdInventoryAttach([root]);
    const out = JSON.parse(
      readFileSync(join(home, 'drafts', 'controls-nav.json'), 'utf8')
    );
    expect(out.controls).toHaveLength(1);
    expect(out.controls[0].stepId).toBe('add_contact');
    expect(out.controls[0].path).toBe('guide-add');
  });
});
