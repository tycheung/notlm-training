/**
 * Linear `requires` from traces always carry `confidence: 'low'`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TraceEvent = {
  at: number;
  type: 'click' | 'navigate' | 'submit';
  guideId?: string;
  selector?: string;
  text?: string;
  url?: string;
};

export type ClickTrace = {
  recordedAt: string;
  baseUrl?: string;
  events: TraceEvent[];
};

export type FlowStepDraft = {
  id: string;
  title: string;
  keywords: string[];
  kind: 'hard' | 'soft' | 'optional' | 'conditional';
  requires: string[];
  /** Non-empty requires must use confidence `low`. */
  confidence: 'high' | 'medium' | 'low';
};

export type TraceFlowDraft = {
  steps: FlowStepDraft[];
  confidence: 'low';
};

export function traceToFlowDraft(trace: ClickTrace): TraceFlowDraft {
  const ordered: Array<{ id: string; title: string }> = [];
  const seen = new Set<string>();

  for (const ev of trace.events) {
    const label = (ev.guideId ?? ev.text ?? '').trim();
    if (!label) continue;
    const id = slugId(ev.guideId ? stripGuide(ev.guideId) : label);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push({
      id,
      title: ev.text?.trim() || humanize(id),
    });
  }

  const steps: FlowStepDraft[] = [];
  let prev: string | null = null;
  for (const item of ordered) {
    const requires = prev ? [prev] : [];
    steps.push({
      id: item.id,
      title: item.title,
      keywords: [item.title.toLowerCase()],
      kind: 'soft',
      requires,
      confidence: 'low',
    });
    prev = item.id;
  }

  return { steps, confidence: 'low' };
}

export function appendTraceEvent(trace: ClickTrace, event: TraceEvent): ClickTrace {
  return {
    ...trace,
    events: [...trace.events, event],
  };
}

export function writeTraceFile(
  notlmHome: string,
  trace: ClickTrace,
  id?: string
): string {
  const traceId = id ?? `trace-${Date.now()}`;
  const dir = join(notlmHome, 'traces');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${traceId}.json`);
  writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  return path;
}

export type SeededIntents = {
  aliases: Record<string, string[]>;
};

export function seedIntentsFromSteps(
  steps: Array<{ id: string; title?: string; keywords?: string[] }>
): SeededIntents {
  const aliases: Record<string, string[]> = {};
  for (const s of steps) {
    const phrases = new Set<string>();
    if (s.title?.trim()) phrases.add(cleanPhrase(s.title));
    phrases.add(cleanPhrase(s.id.replace(/_/g, ' ').replace(/-/g, ' ')));
    for (const k of s.keywords ?? []) {
      if (k.trim()) phrases.add(cleanPhrase(k));
    }
    aliases[s.id] = [...phrases].filter(Boolean);
  }
  return { aliases };
}

export type CorpusSeedCase = {
  id: string;
  utterance: string;
  expect: { stepId: string };
};

/** Corpus from aliases only — no slang invention. */
export function seedCorpusFromAliases(
  aliases: Record<string, string[]>
): CorpusSeedCase[] {
  const cases: CorpusSeedCase[] = [];
  let n = 0;
  for (const [stepId, phrases] of Object.entries(aliases)) {
    for (const utterance of phrases) {
      const clean = cleanPhrase(utterance);
      if (!clean || !isCleanUtterance(clean)) continue;
      n += 1;
      cases.push({
        id: `seed-${n}`,
        utterance: clean,
        expect: { stepId },
      });
    }
  }
  return cases;
}

function stripGuide(guideId: string): string {
  return guideId.replace(/^guide-/, '');
}

function slugId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function humanize(id: string): string {
  return id
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function cleanPhrase(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Reject empty / emoji-heavy / slang-looking seeds — keep titles and plain words. */
function isCleanUtterance(s: string): boolean {
  if (!s || s.length < 2) return false;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(s)) return false;
  if (/[!?]{2,}/.test(s)) return false;
  return /^[a-z0-9][a-z0-9\s\-']*$/i.test(s);
}
