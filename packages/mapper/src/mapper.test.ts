import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { crawlHtml } from './crawlHtml.js';
import { mergeInventory } from './mergeInventory.js';
import { proposeGuideId } from './proposeGuideId.js';
import { mergeGuideIdScan, scanGuideIdsInDir } from './scanGuideIds.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(here, 'fixtures', 'sample.html'), 'utf8');
const scanTree = join(here, 'fixtures', 'scan-tree');


describe('proposeGuideId', () => {
  it('builds stable guide-{role}-{slug} ids', () => {
    expect(proposeGuideId('button', 'Save Tournament')).toBe('guide-button-save-tournament');
    expect(proposeGuideId('link', '  Help!! ')).toBe('guide-link-help');
    expect(proposeGuideId('Button', 'Save Tournament')).toBe('guide-button-save-tournament');
  });

  it('handles empty name', () => {
    expect(proposeGuideId('button', '')).toBe('guide-button-unnamed');
  });
});

describe('crawlHtml', () => {
  it('collects interactive elements from fixture HTML', () => {
    const inv = crawlHtml(fixtureHtml, {
      url: 'http://localhost/lists',
      baseUrl: 'http://localhost',
    });
    expect(inv.baseUrl).toBe('http://localhost');
    expect(inv.controls.length).toBeGreaterThanOrEqual(6);

    const roles = new Set(inv.controls.map((c) => c.role));
    expect(roles.has('link')).toBe(true);
    expect(roles.has('button')).toBe(true);
    expect(roles.has('textbox')).toBe(true);
    expect(roles.has('combobox')).toBe(true);

    const annotated = inv.controls.find((c) => c.existingGuideId === 'guide-button-new-list');
    expect(annotated?.proposedGuideId).toBe('guide-button-new-list');
    expect(annotated?.selectorHint).toBe('[data-guide-id="guide-button-new-list"]');

    const save = inv.controls.find((c) => c.name === 'Save' && c.role === 'button');
    expect(save?.proposedGuideId).toBe('guide-button-save');
  });
});

describe('mergeInventory', () => {
  it('keeps existingGuideId from prior inventory', () => {
    const incoming = crawlHtml(fixtureHtml, { url: '/a', baseUrl: 'http://x' });
    const existing = {
      capturedAt: '2020-01-01T00:00:00.000Z',
      baseUrl: 'http://x',
      controls: incoming.controls.map((c) =>
        c.name === 'Save'
          ? { ...c, existingGuideId: 'guide-button-save-custom', proposedGuideId: 'guide-button-save' }
          : c
      ),
    };
    const stripped = {
      ...incoming,
      controls: incoming.controls.map((c) =>
        c.name === 'Save' ? { ...c, existingGuideId: null } : c
      ),
    };
    const merged = mergeInventory(existing, stripped);
    const save = merged.controls.find((c) => c.name === 'Save');
    expect(save?.existingGuideId).toBe('guide-button-save-custom');
  });
});

describe('scanGuideIdsInDir', () => {
  it('finds data-guide-id in tsx/html and notifyStepCompleted', () => {
    const { guideIds, notifyStepIds, hits } = scanGuideIdsInDir(scanTree);
    expect(guideIds).toEqual(
      expect.arrayContaining(['guide-scan-save', 'guide-scan-html-btn'])
    );
    expect(notifyStepIds).toContain('create_list');
    expect(hits.some((h) => h.kind === 'notifyStepCompleted')).toBe(true);
  });

  it('merges scanned ids into inventory without dropping priors', () => {
    const prior = {
      capturedAt: '2020-01-01T00:00:00.000Z',
      baseUrl: 'http://x',
      controls: [
        {
          role: 'button',
          name: 'Legacy',
          selectorHint: '[data-guide-id="guide-legacy"]',
          existingGuideId: 'guide-legacy',
          proposedGuideId: 'guide-legacy',
          url: '/',
        },
      ],
    };
    const merged = mergeGuideIdScan(prior, scanTree, { baseUrl: 'http://x' });
    const ids = merged.controls.map((c) => c.existingGuideId);
    expect(ids).toEqual(
      expect.arrayContaining(['guide-legacy', 'guide-scan-save', 'guide-scan-html-btn'])
    );
  });
});
