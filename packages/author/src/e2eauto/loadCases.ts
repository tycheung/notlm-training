/**
 * Load host-owned scenario banks (faq-scenarios, cb-handoff, scenarios.json).
 * Never invents product FAQ text — only reads host `.notlm/` JSON.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { E2eCase, E2eExpect } from './types.js';

type RawRow = {
  id?: string;
  utterance?: string;
  text?: string;
  expect?: E2eExpect & Record<string, unknown>;
  expected?: E2eExpect & Record<string, unknown>;
};

function asExpect(raw: unknown): E2eExpect {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  return {
    faqId: typeof o.faqId === 'string' ? o.faqId : o.faqId === null ? null : undefined,
    stepId:
      typeof o.stepId === 'string' ? o.stepId : o.stepId === null ? null : undefined,
    rawIntent:
      typeof o.rawIntent === 'string'
        ? o.rawIntent
        : o.rawIntent === null
          ? null
          : undefined,
    ood: o.ood === true,
    fallthrough: o.fallthrough === true || o.kind === 'fallthrough',
  };
}

function normalizeRow(row: RawRow, source: string, idx: number): E2eCase | null {
  const utterance = String(row.utterance ?? row.text ?? '').trim();
  if (!utterance) return null;
  const expect = asExpect(row.expect ?? row.expected);
  // Host faq-scenarios always carry faqId — treat missing expect as incomplete.
  if (
    !expect.faqId &&
    !expect.stepId &&
    !expect.rawIntent &&
    !expect.ood &&
    !expect.fallthrough
  ) {
    return null;
  }
  const id = String(row.id || `${basename(source, '.json')}-${idx}`);
  return { id, utterance, expect, source };
}

function loadJsonArray(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.cases)) return o.cases;
    if (Array.isArray(o.scenarios)) return o.scenarios;
  }
  return [];
}

/** Default sources when config omits them. */
export const DEFAULT_E2E_SOURCES = [
  'faq-scenarios.json',
  'cb-handoff-scenarios.json',
  'scenarios.json',
];

/**
 * Load + de-dupe cases from home. Also picks up `*-scenarios.json` when
 * `sources` includes the sentinel `*-scenarios.json`.
 */
export function loadE2eCases(
  home: string,
  sources: string[] = DEFAULT_E2E_SOURCES
): E2eCase[] {
  const files = new Set<string>();
  for (const s of sources) {
    if (s === '*-scenarios.json' || s === 'glob:*-scenarios.json') {
      if (!existsSync(home)) continue;
      for (const name of readdirSync(home)) {
        if (/-scenarios\.json$/i.test(name)) files.add(name);
      }
      continue;
    }
    files.add(s);
  }

  const out: E2eCase[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    const path = join(home, rel);
    const rows = loadJsonArray(path);
    rows.forEach((row, idx) => {
      if (!row || typeof row !== 'object') return;
      const c = normalizeRow(row as RawRow, rel, idx);
      if (!c) return;
      const key = `${c.id}::${c.utterance.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    });
  }
  return out;
}

/** Tiny deterministic paraphrases for endless loops (fixture mode). */
export function morphUtterance(text: string, salt: number): string {
  const t = text.trim();
  if (!t) return t;
  const variants = [
    t,
    t.replace(/\?+$/, '') + '?',
    t.replace(/\bwhat's\b/gi, 'whats'),
    t.replace(/\bHow do I\b/g, 'How do i'),
    `please ${t.replace(/\?+$/, '')}?`,
  ];
  return variants[Math.abs(salt) % variants.length] || t;
}
