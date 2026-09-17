import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type JobYamlStep = {
  id: string;
  title: string;
  kind?: 'hard' | 'soft' | 'optional' | 'conditional';
  requires?: string[];
  keywords?: string[];
};

export type JobsDocument = {
  id?: string;
  title?: string;
  jobs: JobYamlStep[];
};

export type FlowStepDraft = {
  id: string;
  title: string;
  keywords: string[];
  kind: 'hard' | 'soft' | 'optional' | 'conditional';
  requires: string[];
};

/**
 * Accepts JSON or a tiny YAML subset (`- id:` / `title:` blocks).
 */
export function jobsToFlowSteps(doc: JobsDocument): FlowStepDraft[] {
  const steps: FlowStepDraft[] = [];
  let prev: string | null = null;
  for (const job of doc.jobs) {
    const requires = job.requires ?? (prev ? [prev] : []);
    steps.push({
      id: job.id,
      title: job.title,
      keywords: job.keywords ?? [job.title.toLowerCase()],
      kind: job.kind ?? 'hard',
      requires,
    });
    prev = job.id;
  }
  return steps;
}

/** Parse a tiny jobs YAML subset without a YAML dependency. */
export function parseJobsYamlLite(text: string): JobsDocument {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as JobsDocument;
  }
  const jobs: JobYamlStep[] = [];
  let current: JobYamlStep | null = null;
  for (const line of trimmed.split(/\r?\n/)) {
    const idMatch = line.match(/^\s*-\s*id:\s*(.+)\s*$/);
    if (idMatch) {
      if (current) jobs.push(current);
      current = { id: stripQuotes(idMatch[1]!), title: stripQuotes(idMatch[1]!) };
      continue;
    }
    const titleMatch = line.match(/^\s*title:\s*(.+)\s*$/);
    if (titleMatch && current) {
      current.title = stripQuotes(titleMatch[1]!);
      continue;
    }
    const kindMatch = line.match(/^\s*kind:\s*(.+)\s*$/);
    if (kindMatch && current) {
      current.kind = stripQuotes(kindMatch[1]!) as JobYamlStep['kind'];
    }
  }
  if (current) jobs.push(current);
  return { jobs };
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^["']|["']$/g, '');
}

export function writeJobsFlowDraft(
  uipilotHome: string,
  doc: JobsDocument,
  draftId = `jobs-${Date.now()}`
): string {
  const outDir = join(uipilotHome, 'drafts', draftId);
  mkdirSync(outDir, { recursive: true });
  const flow = jobsToFlowSteps(doc);
  writeFileSync(join(outDir, 'flow.json'), `${JSON.stringify(flow, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'meta.json'),
    `${JSON.stringify({ id: draftId, kind: 'jobs-flow', checked: false }, null, 2)}\n`
  );
  return outDir;
}
