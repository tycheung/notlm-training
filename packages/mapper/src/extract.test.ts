import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  appendTraceEvent,
  seedCorpusFromAliases,
  seedIntentsFromSteps,
  traceToFlowDraft,
  type ClickTrace,
} from './recordTrace.js';
import { scanForms } from './scanForms.js';
import { scanRoutes } from './scanRoutes.js';
import {
  assertRequiresPolicy,
  runStructuredExtract,
} from './structuredExtract.js';

const here = dirname(fileURLToPath(import.meta.url));
const extractFixture = join(here, 'fixtures', 'extract');

describe('scanRoutes', () => {
  it('finds JSX Route paths and createBrowserRouter object paths', () => {
    const { routes } = scanRoutes(extractFixture);
    const paths = routes.map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining(['/settings', '/help', '/', '/lists', '/lists/:id'])
    );
    const jsx = routes.find((r) => r.path === '/settings');
    expect(jsx?.confidence).toBe('high');
    const obj = routes.find((r) => r.path === '/lists');
    expect(obj?.confidence).toBe('high');
  });
});

describe('scanForms', () => {
  it('detects form, onSubmit, type=submit, and Save/Create CTAs', () => {
    const { forms } = scanForms(extractFixture);
    const kinds = new Set(forms.map((f) => f.kind));
    expect(kinds.has('form')).toBe(true);
    expect(kinds.has('submit')).toBe(true);
    expect(kinds.has('save-cta')).toBe(true);
    expect(forms.some((f) => /Save|Create/i.test(f.nameHint))).toBe(true);
  });
});

describe('runStructuredExtract', () => {
  it('combines routes, forms, and guide ids with empty requires by default', () => {
    const draft = runStructuredExtract(extractFixture);
    expect(draft.screens.length).toBeGreaterThan(0);
    expect(draft.writeCandidates.length).toBeGreaterThan(0);
    expect(draft.guideIds).toEqual(
      expect.arrayContaining([
        'guide-form-settings',
        'guide-textbox-title',
        'guide-button-save-settings',
        'guide-button-create-list',
      ])
    );
    expect(draft.steps.every((s) => s.requires.length === 0)).toBe(true);
    expect(assertRequiresPolicy(draft.steps)).toBe(true);
  });

  it('marks invented linear requires as confidence low', () => {
    const draft = runStructuredExtract(extractFixture, {
      inventLinearRequires: true,
    });
    const withReq = draft.steps.filter((s) => s.requires.length > 0);
    expect(withReq.length).toBeGreaterThan(0);
    expect(withReq.every((s) => s.confidence === 'low')).toBe(true);
    expect(assertRequiresPolicy(draft.steps)).toBe(true);
  });
});

describe('recordTrace', () => {
  it('builds linear low-confidence flow from ordered unique events', () => {
    const trace: ClickTrace = {
      recordedAt: '2026-01-01T00:00:00.000Z',
      events: [
        { at: 1, type: 'click', guideId: 'guide-button-new-list', text: 'New list' },
        { at: 2, type: 'click', guideId: 'guide-button-new-list', text: 'New list' },
        { at: 3, type: 'submit', guideId: 'guide-button-save', text: 'Save' },
      ],
    };
    const { steps, confidence } = traceToFlowDraft(trace);
    expect(confidence).toBe('low');
    expect(steps).toHaveLength(2);
    expect(steps[0]?.requires).toEqual([]);
    expect(steps[1]?.requires).toEqual([steps[0]!.id]);
    expect(steps.every((s) => s.confidence === 'low')).toBe(true);
  });

  it('appends events immutably', () => {
    const base: ClickTrace = { recordedAt: 't', events: [] };
    const next = appendTraceEvent(base, {
      at: 1,
      type: 'navigate',
      url: '/lists',
    });
    expect(base.events).toHaveLength(0);
    expect(next.events).toHaveLength(1);
  });

  it('seeds intents and clean corpus from steps', () => {
    const intents = seedIntentsFromSteps([
      { id: 'create_list', title: 'Create list', keywords: ['new list'] },
    ]);
    expect(intents.aliases.create_list).toEqual(
      expect.arrayContaining(['create list', 'new list'])
    );
    const corpus = seedCorpusFromAliases(intents.aliases);
    expect(corpus.every((c) => c.expect.stepId === 'create_list')).toBe(true);
    expect(corpus.every((c) => /^[a-z0-9\s\-']+$/i.test(c.utterance))).toBe(true);
  });
});
