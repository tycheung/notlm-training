import { describe, expect, it } from 'vitest';
import { attachInventoryToSteps } from './attachControlMap.js';
import type { ControlInventory } from './types.js';

const inventory: ControlInventory = {
  capturedAt: '2026-01-01T00:00:00.000Z',
  baseUrl: 'http://localhost/',
  controls: [
    {
      role: 'button',
      name: 'Add contact',
      selectorHint: 'button',
      existingGuideId: 'guide-add-contact',
      proposedGuideId: 'guide-add-contact',
      url: '/',
    },
    {
      role: 'button',
      name: 'Save',
      selectorHint: 'button',
      existingGuideId: null,
      proposedGuideId: 'guide-btn-save',
      url: '/',
    },
  ],
};

describe('attachInventoryToSteps', () => {
  it('drafts nav stubs for mapped CTAs', () => {
    const result = attachInventoryToSteps(inventory, {
      'guide-add-contact': 'add_contact',
      'guide-btn-save': 'save_contact',
    });
    expect(result.controls).toEqual([
      {
        id: 'guide-add-contact',
        stepId: 'add_contact',
        path: 'guide-add-contact',
        spotlight: 'guide-add-contact',
        coachMessage: 'Focus: Add contact',
        role: 'button',
        name: 'Add contact',
      },
      {
        id: 'guide-btn-save',
        stepId: 'save_contact',
        path: 'guide-btn-save',
        spotlight: 'guide-btn-save',
        coachMessage: 'Focus: Save',
        role: 'button',
        name: 'Save',
      },
    ]);
    expect(result.unmatchedGuideIds).toEqual([]);
    expect(result.unusedInventory).toEqual([]);
  });

  it('reports unmatched map keys and unused inventory', () => {
    const result = attachInventoryToSteps(inventory, {
      'guide-missing': 'noop',
    });
    expect(result.controls).toEqual([]);
    expect(result.unmatchedGuideIds).toEqual(['guide-missing']);
    expect(result.unusedInventory).toEqual(['guide-add-contact', 'guide-btn-save']);
  });
});
